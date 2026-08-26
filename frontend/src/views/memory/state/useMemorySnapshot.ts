import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import type { AxClient } from "../../../transport/AxClient";
import { read, readBatch, rttiResolveBatch } from "../../../protocol/requests";
import { toError } from "../../../state/errors";
import { hexToBytes } from "../nodes/format";
import { offsets, totalSize } from "../nodes/layout";
import { isPointerType, nodeSize } from "../nodes/types";
import { planPreviews } from "../nodes/previewPlan";
import type { PreviewMode } from "./viewerSettings";
import type { MemoryClass } from "./classSerialization";

// The memory viewer's live read. Each fetch reads the active class's whole region, then peeks
// the bytes behind a budgeted, priority-ordered subset of live pointers (one batch) and resolves
// their RTTI names (one batch, cached by target address since an address keeps its class). Lives
// in the view, so it only runs while the memory tab is mounted - the one continuous poll besides
// ping.
//
// Coordination is deliberately single-threaded against a single-threaded agent. There is exactly
// ONE driver - region(), the identity of what we should be reading right now - and at most ONE
// read outstanding at a time. A region change (switch class, edit address, add/resize nodes,
// detach) cancels the in-flight read, clears stale bytes, and reads the new region immediately,
// so a switch is instant and never queues behind a backlog. The next tick is scheduled only AFTER
// the current read settles, so reads can never stampede the agent (a slow agent just yields a
// lower effective poll rate).
//
// Pausing freezes the last snapshot (data is NOT cleared) and stops scheduling; refreshOnce()
// performs exactly one read without resuming the loop. A region change while paused still clears
// the stale bytes - a frozen snapshot must never be displayed against a different class/address.

const POINTER_PREVIEW_BYTES = 16;

export interface PointerInfo {
    target: string;
    previewHex?: string;
    rttiName?: string;
}

export interface PreviewStats {
    /** Unique live pointer targets eligible under the current preview mode. */
    eligible: number;
    /** Targets actually peeked this cycle. */
    read: number;
    /** Eligible targets dropped because the per-cycle budget was exceeded. */
    skipped: number;
}

export interface MemorySnapshot {
    /** The class+address+size this was read for, so the view can drop a snapshot that no longer
     *  matches the active class. See regionKey. */
    key: string;
    view: DataView;
    prev?: DataView;
    pointers: Map<string, PointerInfo>;
    previewStats: PreviewStats;
}

export interface SnapshotOptions {
    intervalMs: Accessor<number>;
    paused: Accessor<boolean>;
    previewMode: Accessor<PreviewMode>;
    maxPreviews: Accessor<number>;
    /** Node ids of pointer rows expanded inline (top-level expansion paths). */
    expandedIds: Accessor<ReadonlySet<string>>;
    selectedIds: Accessor<readonly string[]>;
    /** Node ids currently rendered by the virtualized grid. */
    visibleIds: Accessor<ReadonlySet<string>>;
    /** Identity of the current attachment (workspace key); changing it clears the RTTI cache. */
    cacheEpoch: Accessor<string>;
}

export interface MemoryPoll {
    data: Accessor<MemorySnapshot | null | undefined>;
    error: Accessor<Error | undefined>;
    /** True while a region read is in flight (drives the "Reading" status). */
    reading: Accessor<boolean>;
    /** One full read outside the schedule - the "Refresh once" action while paused. */
    refreshOnce: () => void;
}

/** Stable identity of the region a class currently occupies; "" when there's nothing to read. */
export function regionKey(cls: MemoryClass | undefined): string {
    return cls && cls.address ? `${cls.id}@${cls.address}:${totalSize(cls.nodes)}` : "";
}

export function useMemorySnapshot(
    client: AxClient,
    activeClass: Accessor<MemoryClass | undefined>,
    enabled: Accessor<boolean>,
    opts: SnapshotOptions,
): MemoryPoll {
    const [data, setData] = createSignal<MemorySnapshot | null>();
    const [error, setError] = createSignal<Error>();
    const [reading, setReading] = createSignal(false);

    // RTTI is keyed by absolute target address, which keeps its meaning for the life of an
    // attach. A target/process change (new workspace key) invalidates every cached name.
    const rttiCache = new Map<string, string>();
    createEffect(
        on(opts.cacheEpoch, (_key, prevKey) => {
            if (prevKey !== undefined) rttiCache.clear();
        }),
    );

    // Read one region once: the class's whole span, then a peek + RTTI for the budgeted pointer
    // subset. `prev` is the previous tick's view of this SAME region (the diff baseline) or
    // undefined to start a fresh chain.
    const fetchRegion = async (
        cls: MemoryClass,
        key: string,
        prev: DataView | undefined,
    ): Promise<MemorySnapshot | null> => {
        const { address, nodes } = cls;
        if (!address) return null;
        const size = totalSize(nodes);
        if (size === 0) return null;

        const res = await read(client, { address, size });
        if (!res.success) throw new Error(`could not read ${size} bytes at ${address}`);

        const bytes = hexToBytes(res.data);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        // Decode each pointer-family node's target from the freshly read bytes.
        const offs = offsets(nodes);
        const ptrs: { nodeId: string; target: string }[] = [];
        nodes.forEach((node, i) => {
            if (!isPointerType(node.typeId) || offs[i] + nodeSize(node.typeId) > view.byteLength) return;
            ptrs.push({ nodeId: node.id, target: `0x${view.getBigUint64(offs[i], true).toString(16)}` });
        });
        const live = ptrs.filter((p) => p.target !== "0x0");

        // Plan which targets to peek: expanded > selected > visible, deduplicated, budgeted.
        // Inputs are read untracked at fetch time - scrolling or selecting never restarts the
        // poll loop, it just shapes the next cycle's plan.
        const plan = untrack(() =>
            planPreviews({
                pointers: live,
                mode: opts.previewMode(),
                budget: opts.maxPreviews(),
                expandedIds: opts.expandedIds(),
                selectedIds: new Set(opts.selectedIds()),
                visibleIds: opts.visibleIds(),
            }),
        );

        // Peek the bytes behind the planned targets - they change every tick, so always re-read.
        const previews = new Map<string, string>();
        if (plan.targets.length > 0) {
            const batch = await readBatch(client, {
                reads: plan.targets.map((t) => ({ address: t, size: POINTER_PREVIEW_BYTES })),
            });
            batch.results.forEach((r, i) => {
                if (r.success) previews.set(plan.targets[i], r.data);
            });
        }

        // Resolve RTTI only for peeked targets we haven't classified yet (cache by address).
        const unresolved = plan.targets.filter((t) => !rttiCache.has(t));
        if (unresolved.length > 0) {
            const resolved = await rttiResolveBatch(client, { addresses: unresolved });
            resolved.results.forEach((r, i) => rttiCache.set(unresolved[i], r.success ? r.name : ""));
        }

        const pointers = new Map<string, PointerInfo>();
        for (const p of ptrs) {
            pointers.set(p.nodeId, {
                target: p.target,
                previewHex: previews.get(p.target),
                rttiName: rttiCache.get(p.target) || undefined,
            });
        }

        return {
            key,
            view,
            prev,
            pointers,
            previewStats: { eligible: plan.eligible, read: plan.targets.length, skipped: plan.skipped },
        };
    };

    // The one and only driver: what we should currently be reading - "" when nothing should (the
    // view is detached, or the active class has no address). Every input that changes what to read
    // flows through this memo, so the read loop reacts to all of them through one path.
    const region = createMemo(() => (enabled() ? regionKey(activeClass()) : ""));

    // A monotonic token names the current read loop. A region change (or teardown) bumps it, which
    // abandons any read still in flight and any scheduled next tick for the old region. Each loop
    // schedules its own next tick only after the current read settles, bounding outstanding reads
    // to one PER LOOP; `fetchingToken` additionally guards refreshOnce/resume racing that loop's
    // active read. A region switch deliberately starts the new region's read immediately even if
    // the old one is still hanging - the old result is discarded by the token check.
    let token = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fetchingToken: number | null = null; // token of the loop whose read is in flight
    let prev: DataView | undefined; // diff baseline, reset on every region change

    const runFetch = (key: string, mine: number) => {
        const cls = untrack(activeClass);
        if (mine !== token || !cls || fetchingToken === mine) return;
        fetchingToken = mine;
        setReading(true);
        fetchRegion(cls, key, prev)
            .then(
                (snap) => {
                    if (mine !== token) return;
                    if (snap) {
                        prev = snap.view;
                        setData(() => snap);
                    }
                    setError(undefined);
                },
                (e) => {
                    if (mine !== token) return;
                    prev = undefined; // a failed read breaks the diff chain
                    setError(toError(e));
                },
            )
            .finally(() => {
                // Only clear the in-flight marker if a newer loop hasn't claimed it meanwhile.
                if (fetchingToken === mine) {
                    fetchingToken = null;
                    setReading(false);
                }
                // Schedule the next tick only after this one settled, only if still current, and
                // only while not paused - pausing stops the loop without dropping the snapshot.
                if (mine === token && !untrack(opts.paused)) {
                    timer = setTimeout(() => runFetch(key, mine), untrack(opts.intervalMs));
                }
            });
    };

    createEffect(
        on(region, (key) => {
            token++;
            const mine = token;
            clearTimeout(timer);
            prev = undefined;

            // Drop the previous region's bytes the instant the region changes, so a switch never
            // shows the old class's values against the new class's rows - not even for a frame,
            // and not even while paused (a frozen foreign snapshot is worse than an empty grid).
            setData(null);
            setError(undefined);
            if (!key) return;

            if (!untrack(opts.paused)) runFetch(key, mine); // read the new region NOW - instant switch
            onCleanup(() => {
                token++;
                clearTimeout(timer);
            });
        }),
    );

    // Pause/resume. Pausing cancels the pending timer (no new reads); an in-flight read started
    // before the pause is allowed to land - freezing means "stop asking", not "discard answers".
    // Resuming restarts the loop for the current region immediately.
    createEffect(
        on(
            opts.paused,
            (paused, prevPaused) => {
                if (paused) {
                    clearTimeout(timer);
                    return;
                }
                if (prevPaused === true) {
                    const key = untrack(region);
                    if (key) runFetch(key, token);
                }
            },
            { defer: true },
        ),
    );

    const refreshOnce = () => {
        const key = untrack(region);
        if (!key) return;
        // While paused, runFetch performs one read and schedules nothing; while live it just acts
        // as an immediate tick. inFlight keeps it from doubling an active read either way.
        runFetch(key, token);
    };

    return { data, error, reading, refreshOnce };
}
