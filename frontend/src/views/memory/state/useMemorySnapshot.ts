import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import type { AxClient } from "../../../transport/AxClient";
import { read, readBatch, rttiResolveBatch } from "../../../protocol/requests";
import { config } from "../../../config";
import { toError } from "../../../state/errors";
import { hexToBytes } from "../nodes/format";
import { offsets, totalSize } from "../nodes/layout";
import { nodeSize } from "../nodes/types";
import type { MemoryClass } from "./MemoryContext";

// The memory viewer's live read. Each fetch reads the active class's whole region, then peeks the
// bytes behind every live pointer (one batch) and resolves their RTTI names (one batch, cached by
// target address since an address keeps its class). Lives in the view, so it only runs while the
// memory tab is mounted - the one continuous poll besides ping.
//
// Coordination is deliberately single-threaded against a single-threaded agent. There is exactly
// ONE driver - region(), the identity of what we should be reading right now - and at most ONE read
// outstanding at a time. A region change (switch class, edit address, add/resize nodes, detach)
// cancels the in-flight read, clears stale bytes, and reads the new region immediately, so a switch
// is instant and never queues behind a backlog. The next tick is scheduled only AFTER the current
// read settles, so reads can never stampede the agent (a slow agent just yields a lower poll rate).

const POINTER_PREVIEW_BYTES = 16;

export interface PointerInfo {
    target: string;
    previewHex?: string;
    rttiName?: string;
}

export interface MemorySnapshot {
    /** The class+address+size this was read for, so the view can drop a snapshot that no longer
     *  matches the active class. See regionKey. */
    key: string;
    view: DataView;
    prev?: DataView;
    pointers: Map<string, PointerInfo>;
}

export interface MemoryPoll {
    data: Accessor<MemorySnapshot | null | undefined>;
    error: Accessor<Error | undefined>;
}

/** Stable identity of the region a class currently occupies; "" when there's nothing to read. */
export function regionKey(cls: MemoryClass | undefined): string {
    return cls && cls.address ? `${cls.id}@${cls.address}:${totalSize(cls.nodes)}` : "";
}

export function useMemorySnapshot(
    client: AxClient,
    activeClass: Accessor<MemoryClass | undefined>,
    enabled: Accessor<boolean>,
): MemoryPoll {
    const [data, setData] = createSignal<MemorySnapshot | null>();
    const [error, setError] = createSignal<Error>();

    // RTTI is keyed by absolute target address, which keeps its meaning for the life of an attach,
    // so this is safe (and useful) to share across every region. A process re-attach remounts the
    // whole memory view (base change), giving a fresh cache.
    const rttiCache = new Map<string, string>();

    // Read one region once: the class's whole span, then a peek + RTTI for each live pointer. `prev`
    // is the previous tick's view of this SAME region (the diff baseline) or undefined to start a
    // fresh chain. The class is captured by the caller; we read its fields off the live store object.
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

        // Decode each pointer's target from the freshly read bytes.
        const offs = offsets(nodes);
        const ptrs: { nodeId: string; target: string }[] = [];
        nodes.forEach((node, i) => {
            if (node.typeId !== "pointer" || offs[i] + nodeSize("pointer") > view.byteLength) return;
            ptrs.push({ nodeId: node.id, target: `0x${view.getBigUint64(offs[i], true).toString(16)}` });
        });
        const live = ptrs.filter((p) => p.target !== "0x0");

        // Peek the bytes behind each live pointer - they change every tick, so always re-read.
        const previews = new Map<string, string>();
        if (live.length > 0) {
            const batch = await readBatch(client, {
                reads: live.map((p) => ({ address: p.target, size: POINTER_PREVIEW_BYTES })),
            });
            batch.results.forEach((r, i) => {
                if (r.success) previews.set(live[i].target, r.data);
            });
        }

        // Resolve RTTI only for targets we haven't classified yet (cache by address).
        const unresolved = [...new Set(live.map((p) => p.target))].filter((t) => !rttiCache.has(t));
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

        return { key, view, prev, pointers };
    };

    // The one and only driver: what we should currently be reading - "" when nothing should (the
    // view is detached, or the active class has no address). Every input that changes what to read
    // flows through this memo, so the read loop reacts to all of them through one path.
    const region = createMemo(() => (enabled() ? regionKey(activeClass()) : ""));

    // A monotonic token names the current read loop. A region change (or teardown) bumps it, which
    // abandons any read still in flight and any scheduled next tick for the old region. No shared
    // "running"/"generation" flags, no setInterval - each loop schedules its own next tick only
    // after the current read settles, bounding outstanding reads to one.
    let token = 0;

    createEffect(
        on(region, (key) => {
            const mine = ++token;

            // Drop the previous region's bytes the instant the region changes, so a switch never
            // shows the old class's values against the new class's rows - not even for a frame.
            setData(null);
            setError(undefined);
            if (!key) return;

            let timer: ReturnType<typeof setTimeout> | undefined;
            let prev: DataView | undefined; // diff baseline, local to THIS region's loop

            const tick = () => {
                const cls = untrack(activeClass);
                if (mine !== token || !cls) return;
                fetchRegion(cls, key, prev).then(
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
                ).finally(() => {
                    // Schedule the next tick only after this one settled, and only if still current.
                    if (mine === token) timer = setTimeout(tick, config.memoryPollIntervalMs);
                });
            };

            tick(); // read the new region NOW, not after one interval - this is what makes it instant
            onCleanup(() => {
                token++;
                clearTimeout(timer);
            });
        }),
    );

    return { data, error };
}
