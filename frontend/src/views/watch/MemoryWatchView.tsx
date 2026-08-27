import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { createListVirtualizer } from "../../ui/virtualList";
import { ResizeHandle } from "../../ui/ResizeHandle";
import { usePersistedWidth } from "../../ui/resize";
import { computeDelta } from "../../watch/compare";
import type { MemoryWatchDefinition, WatchValueType } from "../../watch/model";
import { WatchInspector } from "./WatchInspector";
import "./memorywatch.css";

// Memory Watch workspace: a virtualized table of Angel-polling change watches plus a detail
// inspector. Honest by construction — it reports that a value changed, never which instruction
// wrote it. A disabled "Find writer" action states exactly which Angel primitive is missing.

const ROW_H = 30;

const VALUE_TYPES: WatchValueType[] = [
    "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
    "float32", "float64", "bool", "pointer", "bytes", "ascii", "utf8", "utf16le", "utf16be",
];

const AVAIL_LABEL: Record<string, { text: string; tone: string }> = {
    available: { text: "Polling", tone: "live" },
    assumed: { text: "Polling (assumed capability)", tone: "warn" },
    paused: { text: "Paused", tone: "idle" },
    unavailable: { text: "Unavailable — memory.read not negotiated", tone: "danger" },
};

const FIND_WRITER_EXPLAIN =
    "Angel does not expose live thread context, hardware debug registers, breakpoint events, or execution tracing. Memory Watch can detect value changes but cannot identify the writing instruction.";

export function MemoryWatchView() {
    const app = useApp();
    const w = app.watches;

    const [expr, setExpr] = createSignal("");
    const [type, setType] = createSignal<WatchValueType>("int32");
    const [search, setSearch] = createSignal("");
    const [selectedId, setSelectedId] = createSignal<string | null>(null);
    const [importError, setImportError] = createSignal<string>();

    const rows = createMemo(() => {
        const q = search().trim().toLowerCase();
        const list = w.definitions();
        if (!q) return list;
        return list.filter((d) => d.name.toLowerCase().includes(q) || d.expression.toLowerCase().includes(q) || d.tags.some((t) => t.toLowerCase().includes(q)));
    });

    const { setRef, virtualizer } = createListVirtualizer(() => rows().length, ROW_H);

    const hasPending = createMemo(() => w.definitions().some((d) => w.isPending(d.id)));
    const insp = usePersistedWidth("watch.inspector", 380, 260, 720);

    const addWatch = () => {
        const e = expr().trim();
        if (!e) return;
        const id = w.add({ expression: e, valueType: type() });
        setExpr("");
        setSelectedId(id);
    };

    const doExport = () => {
        const blob = new Blob([w.exportDefinitions()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `memory-watches-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };
    const doImport = (file: File) => {
        setImportError(undefined);
        file.text().then((t) => {
            try {
                w.importDefinitions(t, "keepBoth");
            } catch (e) {
                setImportError(e instanceof Error ? e.message : String(e));
            }
        });
    };

    const avail = () => AVAIL_LABEL[w.availability()] ?? AVAIL_LABEL.paused;

    return (
        <div class="mw-view">
            <div class="mw-toolbar">
                <input
                    class="mw-expr"
                    placeholder="Address expression, e.g. client.dll+0x1234 or 0x14000abcd"
                    value={expr()}
                    onInput={(e) => setExpr(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && addWatch()}
                />
                <select class="mw-select" value={type()} onChange={(e) => setType(e.currentTarget.value as WatchValueType)}>
                    <For each={VALUE_TYPES}>{(t) => <option value={t}>{t}</option>}</For>
                </select>
                <button class="mw-btn" onClick={addWatch} title="Add a Memory Watch">+ Watch</button>

                <input class="mw-search" placeholder="Filter…" value={search()} onInput={(e) => setSearch(e.currentTarget.value)} />

                <div class="mw-toolbar-spacer" />

                <span class={`mw-avail tone-${avail().tone}`} title="Memory Watch capability / scheduler state">{avail().text}</span>
                <span class="mw-metrics" title="Scheduler buckets · last cycle bytes received · failures">
                    {w.schedulerBuckets()} bkt · {w.metrics().bytesReceived}B · {w.metrics().failures} err
                </span>

                <Show when={hasPending()}>
                    <button class="mw-btn warn" onClick={() => w.armAllForCurrentTarget()} title="Saved watches load disabled until armed against the current target">Arm saved</button>
                </Show>
                <button class="mw-btn" onClick={() => (w.globalPaused() ? w.resumeAll() : w.pauseAll())}>
                    {w.globalPaused() ? "Resume all" : "Pause all"}
                </button>
                <button class="mw-btn" onClick={() => w.readNowAll()} title="Read every enabled watch once now">Read now</button>
                <button class="mw-btn" onClick={() => w.captureAllBaselines()}>Baselines</button>
                <button class="mw-btn" onClick={doExport}>Export</button>
                <label class="mw-btn" title="Import watch definitions (loaded disabled until armed)">
                    Import
                    <input type="file" accept="application/json,.json" style={{ display: "none" }} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) doImport(f); e.currentTarget.value = ""; }} />
                </label>
                <button class="mw-btn danger" onClick={() => w.clearAllHistory()}>Clear history</button>
                <button class="mw-btn disabled" disabled title={FIND_WRITER_EXPLAIN}>Find writer ⚠</button>
            </div>

            <Show when={importError()}>
                <div class="mw-error-bar">Import failed: {importError()}</div>
            </Show>

            <div class="mw-body">
                <div class="mw-table">
                    <div class="mw-thead">
                        <span class="mw-col-en" />
                        <span class="mw-col-name">Name</span>
                        <span class="mw-col-expr">Expression</span>
                        <span class="mw-col-addr">Resolved</span>
                        <span class="mw-col-type">Type</span>
                        <span class="mw-col-val">Current</span>
                        <span class="mw-col-val">Previous</span>
                        <span class="mw-col-delta">Δ</span>
                        <span class="mw-col-int">Interval</span>
                        <span class="mw-col-cnt">Chg</span>
                        <span class="mw-col-status">Status</span>
                    </div>
                    <div class="mw-tbody" ref={setRef}>
                        <Show when={rows().length > 0} fallback={<div class="mw-empty">No watches. Add one above, or right-click an address elsewhere → “Add Memory Watch”.</div>}>
                            <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
                                <For each={virtualizer.getVirtualItems()}>
                                    {(vi) => {
                                        const def = () => rows()[vi.index];
                                        return (
                                            <div class="mw-row-abs" style={{ transform: `translateY(${vi.start}px)`, height: `${ROW_H}px` }}>
                                                <WatchRow def={def()} selected={selectedId() === def().id} onSelect={setSelectedId} />
                                            </div>
                                        );
                                    }}
                                </For>
                            </div>
                        </Show>
                    </div>
                </div>

                <Show when={selectedId() && w.byId(selectedId()!)}>
                    <ResizeHandle value={insp.width()} min={insp.min} max={insp.max} onSet={insp.set} onReset={insp.reset} label="Resize watch inspector" />
                    <div class="mw-inspector-wrap" style={{ width: `${insp.width()}px` }}>
                        <WatchInspector id={selectedId()!} onClose={() => setSelectedId(null)} />
                    </div>
                </Show>
            </div>
        </div>
    );
}

function WatchRow(props: { def: MemoryWatchDefinition; selected: boolean; onSelect: (id: string) => void }) {
    const app = useApp();
    const w = app.watches;
    const d = () => props.def;
    const rt = () => w.runtime(d().id);
    const pending = () => w.isPending(d().id);

    return (
        <div
            class="mw-row"
            classList={{ selected: props.selected, disabled: !d().enabled, pending: pending(), flagged: rt().trigger?.flagged, [`st-${rt().status}`]: true }}
            onClick={() => props.onSelect(d().id)}
        >
            <span class="mw-col-en">
                <input
                    type="checkbox"
                    checked={d().enabled}
                    aria-label={`Enable ${d().name}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => w.setEnabled(d().id, e.currentTarget.checked)}
                />
            </span>
            <span class="mw-col-name" title={d().name}>{d().name}</span>
            <span class="mw-col-expr" title={d().expression}>{d().expression}</span>
            <span class="mw-col-addr" title={rt().resolvedAddress}>{rt().resolvedAddress ?? "—"}</span>
            <span class="mw-col-type">{d().valueType}</span>
            <Show when={rt().current} fallback={<span class="mw-col-val">—</span>} keyed>
                {(cur) => (
                    <span class="mw-col-val mw-flash" data-v={cur.bytesHex} title={cur.error ?? cur.display}>{cur.display}</span>
                )}
            </Show>
            <span class="mw-col-val">{rt().previous?.display ?? "—"}</span>
            <span class="mw-col-delta">{computeDelta(rt().current, rt().previous) ?? ""}</span>
            <span class="mw-col-int">{d().intervalMs}ms</span>
            <span class="mw-col-cnt">{rt().changeCount}</span>
            <span class="mw-col-status">
                <span class="mw-status-glyph" aria-hidden="true">{STATUS_GLYPH[rt().status]}</span>
                <span class="mw-status-text">{pending() ? "pending" : rt().status}</span>
            </span>
        </div>
    );
}

const STATUS_GLYPH: Record<string, string> = {
    idle: "○",
    resolving: "◔",
    reading: "◑",
    ready: "●",
    paused: "‖",
    error: "▲",
    stale: "◌",
};
