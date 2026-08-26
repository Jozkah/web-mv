import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { useApp } from "../../app/AppContext";
import { StatusOverlay } from "../../ui/StatusOverlay";
import { readBatch } from "../../protocol/requests";
import { totalSize } from "./nodes/layout";
import { finalizeSuggestion, meetsThreshold, planSuggestions, sameFields, type Suggestion } from "./nodes/guess";
import { captureBaseline, baselineValid, type Baseline } from "./nodes/baseline";
import { filterNodes, indexAtOffset, nearestVisiblePosition, parseGotoOffset, type FilterMode } from "./nodes/filter";
import { NODE_TYPES, type GuessField } from "./nodes/types";
import { parseHex } from "../../state/address";
import { useMemory } from "./state/MemoryContext";
import { regionKey, useMemorySnapshot } from "./state/useMemorySnapshot";
import { createViewerSettings } from "./state/viewerSettings";
import { useDataTypes } from "../datatypes/state/DataTypesContext";
import { ClassSidebar } from "./components/ClassSidebar";
import { AddressBar } from "./components/AddressBar";
import { MemoryToolbar, type PollStatus } from "./components/MemoryToolbar";
import { NodeGrid, type GridController } from "./components/NodeGrid";
import { MemoryFooter } from "./components/MemoryFooter";

// The memory viewer ("dynamic" analysis): a class sidebar, an address bar, the live-inspection
// toolbar, and the live node grid for the active class. The poll lives here so it only runs
// while this view is mounted; the class definitions persist in the provider above the view
// switch. This component orchestrates the transient inspection state - pause/baseline/search/
// analysis suggestions - all of which is derived from (and invalidated by) the region identity,
// never persisted as bytes.
//
// Switching/deleting a class is a pure synchronous store update the grid re-renders from; it
// never touches the network. The poll reads the new region in the background and supersedes any
// in-flight read on a switch (see useMemorySnapshot), so it can't block or stall the UI.

export function MemoryView(props: {
    classId?: string;
    tabId?: string;
    /** True when this view is in the focused group - only then does it drive global selection. */
    canBind?: boolean;
    onBindClass?: (classId: string) => void;
    onTitle?: (title: string) => void;
}) {
    const app = useApp();
    const memory = useMemory();
    const dt = useDataTypes();
    const viewer = createViewerSettings();

    const activeClass = () => {
        if (props?.classId) {
            return memory.classes.find((c) => c.id === props.classId) ?? memory.activeClass();
        }
        return memory.activeClass();
    };
    const nodes = () => activeClass()?.nodes ?? [];
    const baseAddress = () => activeClass()?.address ?? "";
    const size = () => totalSize(nodes());

    // Tab binding. A memory tab remembers which class it shows. While this tab is focused, the
    // global selection (which the sidebar, address bar, and node edits all target) is kept pointed
    // at this tab's class - and picking a different class in the sidebar re-binds the tab to it.
    // An unfocused side-by-side memory tab just displays its own class without touching selection.
    createEffect(() => {
        if (!props?.canBind) return;
        const bound = props.classId;
        if (bound && memory.classes.some((c) => c.id === bound)) {
            untrack(() => {
                if (memory.activeId !== bound) memory.selectClass(bound);
            });
        }
    });
    createEffect(() => {
        if (!props?.canBind) return;
        const gid = memory.activeId;
        const bound = untrack(() => props.classId);
        if (gid && gid !== bound) props.onBindClass?.(gid);
    });

    // Keep the tab's title in sync with the class it shows (e.g. "PlayerManager").
    createEffect(() => {
        const c = activeClass();
        if (c && props?.onTitle) props.onTitle(c.name);
    });

    // --- live inspection state -----------------------------------------------------------------

    const [paused, setPaused] = createSignal(viewer.settings.startPaused);
    const togglePause = () => {
        const next = !paused();
        setPaused(next);
        viewer.setStartPaused(next); // preference persists; the frozen bytes never do
    };

    // Node ids the pointer-preview planner treats as "expanded": top-level expansion paths only
    // (nested paths belong to PointerExpansion's own reads).
    const expandedIds = createMemo<ReadonlySet<string>>(
        () => new Set(memory.expandedPaths.filter((p) => !p.includes("/"))),
    );
    const [visibleIds, setVisibleIds] = createSignal<ReadonlySet<string>>(new Set());

    const enabled = () => app.attached();
    const poll = useMemorySnapshot(app.client, activeClass, enabled, {
        intervalMs: () => viewer.settings.intervalMs,
        paused,
        previewMode: () => viewer.settings.previewMode,
        maxPreviews: () => viewer.settings.maxPreviews,
        expandedIds,
        selectedIds: () => memory.selectedNodeIds,
        visibleIds,
        cacheEpoch: () => app.workspaceKey(),
    });

    // Focus handle for the address input, so the empty-state's primary action lands the caret there.
    let addrInput: HTMLInputElement | undefined;

    // Recent addresses from the jump history (newest first, unique) offered as quick empty-state
    // chips: clicking one points the active class at it and the poll reads there immediately.
    const recentAddresses = createMemo(() => {
        const seen = new Set<string>();
        const out: { address: string; label?: string }[] = [];
        const entries = app.nav.entries;
        for (let i = entries.length - 1; i >= 0 && out.length < 4; i--) {
            const e = entries[i];
            if (seen.has(e.address)) continue;
            seen.add(e.address);
            out.push({ address: e.address, label: e.label });
        }
        return out;
    });

    // Hand the grid (and analysis) a snapshot only while it still matches the active class, so a
    // switch clears the old bytes instead of briefly showing them against the new class's rows.
    const snapshot = () => {
        const s = poll.data();
        const cls = activeClass();
        if (!s || !cls) return s;
        return s.key === regionKey(cls) ? s : undefined;
    };

    // --- baseline ------------------------------------------------------------------------------

    const [baseline, setBaseline] = createSignal<Baseline | undefined>();
    const [changedOnly, setChangedOnly] = createSignal(false);

    // A baseline is bound to the exact region it was captured from; changing class, base address,
    // or layout size makes the byte comparison meaningless, so it (and changed-only) invalidate.
    createEffect(() => {
        const key = regionKey(activeClass());
        const b = untrack(baseline);
        if (b && b.key !== key) {
            setBaseline(undefined);
            setChangedOnly(false);
        }
    });

    const doCaptureBaseline = () => {
        const snap = snapshot();
        if (snap) setBaseline(captureBaseline(snap.key, snap.view));
    };
    const doClearBaseline = () => {
        setBaseline(undefined);
        setChangedOnly(false);
    };

    // --- search / filter -----------------------------------------------------------------------

    const [queryRaw, setQueryRaw] = createSignal("");
    const [query, setQuery] = createSignal("");
    // Debounce the search text so a large class doesn't re-filter on every keystroke.
    createEffect(() => {
        const q = queryRaw();
        const handle = setTimeout(() => setQuery(q), 120);
        onCleanup(() => clearTimeout(handle));
    });
    const [filterMode, setFilterMode] = createSignal<FilterMode>("all");

    const refResolvers = {
        formatEnum: (name: string, value: number) =>
            dt.enumByName(name) ? dt.formatEnumValue(name, value) : undefined,
        hasStruct: (name: string) => dt.structByName(name) !== undefined,
    };

    // The grid's row list: original node indices surviving the search + filter. Changed-only is
    // a hard overlay over whatever filter is picked (both express "changed from baseline").
    const visibleRows = createMemo<number[]>(() => {
        const mode = changedOnly() ? "changed" : filterMode();
        const snap = snapshot();
        const base = baseline();
        return filterNodes({
            nodes: nodes(),
            query: query(),
            mode,
            base: baseAddress() ? parseHex(baseAddress()) : undefined,
            view: snap?.view,
            baseline: baselineValid(base, regionKey(activeClass())) ? base : undefined,
            refs: refResolvers,
        });
    });

    let gridController: GridController | undefined;

    const gotoOffset = (text: string) => {
        const off = parseGotoOffset(text);
        if (off === undefined) return;
        const idx = indexAtOffset(nodes(), off);
        if (idx === undefined) return;
        const node = nodes()[idx];
        memory.selectNode(node.id);
        gridController?.scrollToPosition(nearestVisiblePosition(visibleRows(), idx));
    };

    // --- controlled analysis -------------------------------------------------------------------

    const [suggestions, setSuggestions] = createSignal<ReadonlyMap<string, Suggestion>>(new Map());
    const [analyzing, setAnalyzing] = createSignal(false);
    // Nodes whose suggestion the user rejected, per region - the auto pass must not resurrect
    // them every tick. Reset on region change and on a fresh manual Analyze.
    let rejectedIds = new Set<string>();

    // Stale-analysis protection: any region change (class, address, layout size) throws away
    // pending suggestions AND the rejection memory - they were derived from other bytes.
    createEffect(
        on(
            () => regionKey(activeClass()),
            () => {
                setSuggestions(new Map());
                rejectedIds = new Set();
            },
        ),
    );

    let analysisBusy = false;

    // One analysis pass over the current snapshot: classify untyped tiles, confirm pointer
    // candidates with ONE batched read, then either auto-apply high-confidence results (auto
    // mode) or stage everything for review (manual Analyze). Guarded against overlapping runs
    // and against the region changing mid-flight.
    const runAnalysis = async (auto: boolean) => {
        if (analysisBusy) return;
        const snap = poll.data();
        const cls = activeClass();
        if (!snap || !cls || !app.attached()) return;

        const planRegion = regionKey(cls);
        if (snap.key !== planRegion) return; // the poll can lag a switch

        const plan = planSuggestions(cls.nodes, snap.view);
        if (plan.length === 0) {
            if (!auto) setSuggestions(new Map());
            return;
        }

        analysisBusy = true;
        if (!auto) setAnalyzing(true);
        try {
            const candidates = plan.filter((p) => p.pointerTarget);
            const confirmed = new Set<string>();
            if (candidates.length > 0) {
                let batch;
                try {
                    batch = await readBatch(app.client, {
                        reads: candidates.map((c) => ({ address: c.pointerTarget!, size: 8 })),
                    });
                } catch {
                    return; // agent hiccup mid-confirm: retry on the next snapshot / next click
                }
                candidates.forEach((c, i) => batch.results[i]?.success && confirmed.add(c.nodeId));
            }

            // Drop everything if the region changed during the confirm read (switch, edit, resize).
            if (regionKey(activeClass()) !== planRegion) return;

            const final = plan
                .map((s) => finalizeSuggestion(s, confirmed.has(s.nodeId)))
                .filter((s) => s.fields.length > 0);

            if (auto) {
                // Automatic mode applies only high-confidence results (verified pointers,
                // terminated strings); applyGuesses itself still skips anything the user has
                // typed or locked in the meantime. The rest become reviewable suggestions.
                const highs = final.filter((s) => meetsThreshold(s.confidence, "high"));
                if (highs.length > 0) {
                    memory.applyGuesses(new Map(highs.map((s) => [s.nodeId, s.fields])));
                }
                const pending = final.filter(
                    (s) => !meetsThreshold(s.confidence, "high") && !rejectedIds.has(s.nodeId),
                );
                setSuggestions(new Map(pending.map((s) => [s.nodeId, s])));
            } else {
                // Manual Analyze stages everything (high included) for explicit review and
                // forgets previous rejections - the user asked for a fresh pass.
                rejectedIds = new Set();
                setSuggestions(new Map(final.map((s) => [s.nodeId, s])));
            }
        } finally {
            analysisBusy = false;
            setAnalyzing(false);
        }
    };

    // Auto pass on each fresh snapshot while enabled (toggle on, attached, not paused). untrack
    // keeps it from subscribing to the node/active-class reads it makes; typed tiles drop out of
    // the plan, so steady state is a cheap no-op. Then auto-grow the class when live data has
    // reached its tail (bounded at AUTO_GROW_MAX; see MemoryContext) - growth also stops while
    // paused, detached, or toggled off.
    createEffect(() => {
        poll.data();
        untrack(() => {
            if (paused() || !app.attached()) return;
            if (memory.autoGuess) void runAnalysis(true);
            if (memory.autoGrow) memory.autoGrowActiveClass();
        });
    });

    // Accept-time staleness check: re-derive the classification for this node against the
    // CURRENT snapshot; a suggestion computed from older bytes that no longer reproduces is
    // dropped instead of applied.
    const suggestionStillValid = (s: Suggestion): boolean => {
        const snap = snapshot();
        const cls = activeClass();
        if (!snap || !cls) return false;
        const node = cls.nodes.find((n) => n.id === s.nodeId);
        if (!node) return false;
        const fresh = planSuggestions(cls.nodes, snap.view).find((p) => p.nodeId === s.nodeId);
        if (!fresh) return false;
        // A confirmed-pointer suggestion stays valid while the slot still reads as a pointer
        // candidate; other suggestions must reproduce the same replacement fields.
        if (s.fields.length === 1 && s.fields[0] === "pointer") return fresh.pointerTarget !== undefined;
        return sameFields(fresh.fields, s.fields);
    };

    const removeSuggestions = (ids: string[]) => {
        setSuggestions((prev) => {
            const next = new Map(prev);
            for (const id of ids) next.delete(id);
            return next;
        });
    };

    const acceptSuggestions = (ids: string[]) => {
        const staged = suggestions();
        const apply = new Map<string, GuessField[]>();
        const drop: string[] = [];
        for (const id of ids) {
            const s = staged.get(id);
            if (!s) continue;
            if (suggestionStillValid(s)) apply.set(id, s.fields);
            drop.push(id); // applied or stale - either way it leaves the pending set
        }
        if (apply.size > 0) memory.applyGuesses(apply);
        removeSuggestions(drop);
    };

    const rejectSuggestions = (ids: string[]) => {
        for (const id of ids) rejectedIds.add(id);
        removeSuggestions(ids);
    };

    const suggestionLabel = (s: Suggestion): string =>
        s.fields
            .map((f) => (typeof f === "string" ? NODE_TYPES[f].label : `${f.typeId}[${f.length}]`))
            .join(" · ");

    const selectedSuggestionIds = () =>
        memory.selectedNodeIds.filter((id) => suggestions().has(id));

    // --- toolbar wiring ------------------------------------------------------------------------

    const status = (): PollStatus => {
        if (app.attached() && poll.error()) return "error";
        if (poll.reading()) return "reading";
        if (paused()) return "paused";
        return "live";
    };

    return (
        <div class="memory-view">
            <ClassSidebar />
            <div class="memory-main">
                <AddressBar inputRef={(el) => (addrInput = el)} />
                <Show when={activeClass() && baseAddress() !== ""}>
                    <MemoryToolbar
                        status={status}
                        statusDetail={() => poll.error()?.message}
                        paused={paused}
                        onTogglePause={togglePause}
                        onRefreshOnce={() => poll.refreshOnce()}
                        intervalMs={() => viewer.settings.intervalMs}
                        onInterval={(ms) => viewer.setIntervalMs(ms)}
                        hasBaseline={() => baselineValid(baseline(), regionKey(activeClass()))}
                        hasSnapshot={() => !!snapshot()}
                        onCaptureBaseline={doCaptureBaseline}
                        onClearBaseline={doClearBaseline}
                        changedOnly={changedOnly}
                        onToggleChangedOnly={() => setChangedOnly((v) => !v)}
                        previewMode={() => viewer.settings.previewMode}
                        onPreviewMode={(m) => viewer.setPreviewMode(m)}
                        maxPreviews={() => viewer.settings.maxPreviews}
                        onMaxPreviews={(n) => viewer.setMaxPreviews(n)}
                        previewSkipped={() => snapshot()?.previewStats.skipped ?? 0}
                        query={queryRaw}
                        onQuery={setQueryRaw}
                        filter={filterMode}
                        onFilter={setFilterMode}
                        resultCount={() => visibleRows().length}
                        totalCount={() => nodes().length}
                        onClearFilters={() => {
                            setQueryRaw("");
                            setQuery("");
                            setFilterMode("all");
                            setChangedOnly(false);
                        }}
                        onGoto={gotoOffset}
                        autoGuess={() => memory.autoGuess}
                        onToggleAutoGuess={() => memory.setAutoGuess(!memory.autoGuess)}
                        autoGrow={() => memory.autoGrow}
                        onToggleAutoGrow={() => memory.setAutoGrow(!memory.autoGrow)}
                        onAnalyze={() => void runAnalysis(false)}
                        analyzing={analyzing}
                        suggestionCount={() => suggestions().size}
                        selectedSuggestionCount={() => selectedSuggestionIds().length}
                        onAcceptAllSuggestions={() => acceptSuggestions([...suggestions().keys()])}
                        onAcceptSelectedSuggestions={() => acceptSuggestions(selectedSuggestionIds())}
                        onRejectSuggestions={() => rejectSuggestions([...suggestions().keys()])}
                    />
                </Show>
                <div class="memory-body">
                    <NodeGrid
                        nodes={nodes}
                        baseAddress={baseAddress}
                        snapshot={snapshot}
                        baseline={baseline}
                        visible={visibleRows}
                        paused={paused}
                        suggestions={suggestions}
                        suggestionLabel={suggestionLabel}
                        onAcceptSuggestion={(id) => acceptSuggestions([id])}
                        onRejectSuggestion={(id) => rejectSuggestions([id])}
                        onDismissSuggestions={() => rejectSuggestions([...suggestions().keys()])}
                        onVisibleIds={setVisibleIds}
                        onWriteDone={() => poll.refreshOnce()}
                        controller={(api) => (gridController = api)}
                    />

                    {/* Actionable empty state: no class, or a class with no address yet. */}
                    <Show when={!activeClass()}>
                        <div class="mem-empty">
                            <div class="mem-empty-card">
                                <p class="mem-empty-title">No class yet</p>
                                <p class="mem-empty-sub">A class is a memory layout you reconstruct field by field.</p>
                                <div class="mem-empty-actions">
                                    <button
                                        class="mem-empty-primary"
                                        onClick={() => {
                                            memory.addClass();
                                            queueMicrotask(() => addrInput?.focus());
                                        }}
                                    >
                                        New class
                                    </button>
                                </div>
                            </div>
                        </div>
                    </Show>

                    <Show when={!!activeClass() && baseAddress() === ""}>
                        <div class="mem-empty">
                            <div class="mem-empty-card">
                                <p class="mem-empty-title">Point this class at memory</p>
                                <p class="mem-empty-sub">
                                    Enter an address or a <code>module+offset</code> to start reading live bytes.
                                </p>
                                <div class="mem-empty-actions">
                                    <button class="mem-empty-primary" onClick={() => addrInput?.focus()}>
                                        Enter address
                                    </button>
                                    <Show when={!app.attached()}>
                                        <button class="mem-empty-secondary" onClick={() => app.followLive()}>
                                            Follow Live
                                        </button>
                                    </Show>
                                </div>
                                <Show when={!app.attached()}>
                                    <p class="mem-empty-note">No process attached — attach one in the agent, then Follow Live.</p>
                                </Show>
                                <Show when={recentAddresses().length > 0}>
                                    <div class="mem-empty-recent">
                                        <span class="mem-empty-recent-head">Recent</span>
                                        <For each={recentAddresses()}>
                                            {(r) => (
                                                <button
                                                    class="mem-empty-chip"
                                                    title={r.label ? `${r.label} — ${r.address}` : r.address}
                                                    onClick={() => {
                                                        memory.setAddress(r.address);
                                                        queueMicrotask(() => addrInput?.focus());
                                                    }}
                                                >
                                                    {r.label ?? r.address}
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </div>
                        </div>
                    </Show>

                    <StatusOverlay message={baseAddress() !== "" && !app.attached() && "agent not attached"} />
                    <StatusOverlay message={app.attached() && poll.error()?.message} error />
                </div>
                <MemoryFooter nodes={nodes} size={size} />
            </div>
        </div>
    );
}
