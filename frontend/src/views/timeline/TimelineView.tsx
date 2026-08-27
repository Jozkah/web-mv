import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { createListVirtualizer } from "../../ui/virtualList";
import type { TimelineEvent, TimelineEventSeverity, TimelineEventSource } from "../../timeline/events";
import type { TimelineGroupBy } from "../../timeline/timelineStore";
import "./timeline.css";

// The unified timeline: a virtualized, filterable, groupable view over the central event store.
// It renders ONLY from TimelineEvent base fields, so it stays decoupled from every producer's own
// store. Detail inspector, correlation jumps, and JSON export/import round out the foundation.

const ROW_H = 46;

const SOURCES: TimelineEventSource[] = [
    "session",
    "relay",
    "agent",
    "capability",
    "target",
    "module",
    "memory",
    "scanner",
    "emulator",
    "patch",
    "network",
    "user",
];

const SEVERITIES: TimelineEventSeverity[] = ["debug", "info", "notice", "warning", "error"];
const GROUP_OPTIONS: TimelineGroupBy[] = ["none", "source", "type", "severity", "generation"];

const SEV_GLYPH: Record<TimelineEventSeverity, string> = {
    debug: "·",
    info: "●",
    notice: "◆",
    warning: "▲",
    error: "✕",
};

type DisplayRow =
    | { kind: "header"; key: string; count: number }
    | { kind: "event"; event: TimelineEvent };

export function TimelineView() {
    const app = useApp();
    const tl = app.timeline;

    const [text, setText] = createSignal("");
    const [minSeverity, setMinSeverity] = createSignal<TimelineEventSeverity | "">("");
    const [activeSources, setActiveSources] = createSignal<Set<TimelineEventSource>>(new Set());
    const [currentGenOnly, setCurrentGenOnly] = createSignal(false);

    // Push the local filter controls into the store's filter (the store owns filtering).
    const applyFilter = () => {
        const sources = [...activeSources()];
        tl.setFilter({
            text: text() || undefined,
            minSeverity: minSeverity() || undefined,
            sources: sources.length ? sources : undefined,
            generation: currentGenOnly() ? "current" : "all",
        });
    };

    const toggleSource = (s: TimelineEventSource) => {
        setActiveSources((cur) => {
            const next = new Set(cur);
            if (next.has(s)) next.delete(s);
            else next.add(s);
            return next;
        });
        applyFilter();
    };

    // Flatten filtered events (+ group headers) into a single virtualizable row list.
    const rows = createMemo<DisplayRow[]>(() => {
        const by = tl.groupBy();
        if (by === "none") {
            return tl.filtered().map((event) => ({ kind: "event", event }) as DisplayRow);
        }
        const out: DisplayRow[] = [];
        for (const g of tl.groups()) {
            out.push({ kind: "header", key: g.key || "—", count: g.events.length });
            for (const event of g.events) out.push({ kind: "event", event });
        }
        return out;
    });

    const { setRef, virtualizer } = createListVirtualizer(() => rows().length, ROW_H);

    const selected = () => tl.selected();

    const doExport = () => {
        const blob = new Blob([tl.exportJSON()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `timeline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const [importError, setImportError] = createSignal<string>();
    const doImport = (file: File) => {
        setImportError(undefined);
        file.text()
            .then((txt) => {
                const n = tl.importJSON(txt);
                app.timeline.ingest({
                    type: "user.annotation",
                    source: "user",
                    severity: "info",
                    summary: `Imported ${n} timeline events`,
                    tags: ["import"],
                    provenance: "user:import",
                });
            })
            .catch((e) => setImportError(e instanceof Error ? e.message : String(e)));
    };

    const addNote = () => {
        const note = prompt("Timeline note:");
        if (!note) return;
        const sel = selected();
        tl.ingest({
            type: "user.annotation",
            source: "user",
            severity: "info",
            summary: note,
            tags: ["note"],
            relatedEventIds: sel ? [sel.id] : undefined,
            provenance: "user:annotation",
            confidence: "exact",
        });
    };

    return (
        <div class="timeline-view">
            <div class="timeline-toolbar">
                <input
                    class="timeline-search"
                    type="text"
                    placeholder="Filter events by summary, type, module, address, tag…"
                    value={text()}
                    onInput={(e) => {
                        setText(e.currentTarget.value);
                        applyFilter();
                    }}
                />
                <select
                    class="timeline-select"
                    title="Minimum severity"
                    value={minSeverity()}
                    onChange={(e) => {
                        setMinSeverity(e.currentTarget.value as TimelineEventSeverity | "");
                        applyFilter();
                    }}
                >
                    <option value="">All severities</option>
                    <For each={SEVERITIES}>{(s) => <option value={s}>{`≥ ${s}`}</option>}</For>
                </select>
                <select
                    class="timeline-select"
                    title="Group by"
                    value={tl.groupBy()}
                    onChange={(e) => tl.setGroupBy(e.currentTarget.value as TimelineGroupBy)}
                >
                    <For each={GROUP_OPTIONS}>{(g) => <option value={g}>{g === "none" ? "No grouping" : `Group: ${g}`}</option>}</For>
                </select>
                <label class="timeline-checkbox" title="Show only events from the current target generation">
                    <input
                        type="checkbox"
                        checked={currentGenOnly()}
                        onChange={(e) => {
                            setCurrentGenOnly(e.currentTarget.checked);
                            applyFilter();
                        }}
                    />
                    Current target only
                </label>
                <div class="timeline-toolbar-spacer" />
                <button class="timeline-btn" onClick={addNote} title="Add a user annotation event">+ Note</button>
                <button class="timeline-btn" onClick={doExport} title="Export the timeline as JSON">Export</button>
                <label class="timeline-btn" title="Import a previously exported timeline JSON">
                    Import
                    <input
                        type="file"
                        accept="application/json,.json"
                        style={{ display: "none" }}
                        onChange={(e) => {
                            const f = e.currentTarget.files?.[0];
                            if (f) doImport(f);
                            e.currentTarget.value = "";
                        }}
                    />
                </label>
                <button class="timeline-btn danger" onClick={() => tl.clear()} title="Clear all events">Clear</button>
            </div>

            <div class="timeline-meta">
                <span>{tl.count()} events</span>
                <span>· generation {tl.currentGeneration()}</span>
                <Show when={tl.dropped() > 0}>
                    <span class="timeline-dropped" title="Oldest events were dropped to keep the timeline bounded">
                        · {tl.dropped()} dropped (retention cap)
                    </span>
                </Show>
                <Show when={importError()}>
                    <span class="timeline-error">· import failed: {importError()}</span>
                </Show>
            </div>

            <div class="timeline-body">
                <div class="timeline-list" ref={setRef}>
                    <Show
                        when={rows().length > 0}
                        fallback={<div class="timeline-empty">No events match the current filter.</div>}
                    >
                        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
                            <For each={virtualizer.getVirtualItems()}>
                                {(vi) => {
                                    const row = () => rows()[vi.index];
                                    return (
                                        <div
                                            class="timeline-row-abs"
                                            style={{ transform: `translateY(${vi.start}px)`, height: `${ROW_H}px` }}
                                        >
                                            <Show
                                                when={row().kind === "event"}
                                                fallback={
                                                    <div class="timeline-group-header">
                                                        <span class="timeline-group-key">{(row() as { key: string }).key}</span>
                                                        <span class="timeline-group-count">{(row() as { count: number }).count}</span>
                                                    </div>
                                                }
                                            >
                                                <EventRow
                                                    event={(row() as { event: TimelineEvent }).event}
                                                    selected={selected()?.id === (row() as { event: TimelineEvent }).event.id}
                                                    onSelect={(id) => tl.select(id)}
                                                />
                                            </Show>
                                        </div>
                                    );
                                }}
                            </For>
                        </div>
                    </Show>
                </div>

                <div class="timeline-sources">
                    <div class="timeline-sources-head">Sources</div>
                    <For each={SOURCES}>
                        {(s) => (
                            <button
                                class="timeline-source-chip"
                                classList={{ active: activeSources().has(s) }}
                                onClick={() => toggleSource(s)}
                            >
                                {s}
                            </button>
                        )}
                    </For>
                </div>

                <Show when={selected()}>
                    {(ev) => <Inspector event={ev()} onSelect={(id) => tl.select(id)} related={tl.related(ev().id)} />}
                </Show>
            </div>
        </div>
    );
}

function EventRow(props: { event: TimelineEvent; selected: boolean; onSelect: (id: string) => void }) {
    const e = props.event;
    return (
        <div
            class="timeline-row"
            classList={{ selected: props.selected, [`sev-${e.severity}`]: true }}
            onClick={() => props.onSelect(e.id)}
        >
            <span class="timeline-sev" aria-hidden="true">{SEV_GLYPH[e.severity]}</span>
            <div class="timeline-row-body">
                <div class="timeline-row-top">
                    <span class="timeline-summary">{e.summary}</span>
                    <span class="timeline-source-tag">{e.source}</span>
                </div>
                <div class="timeline-row-sub">
                    <span class="timeline-seq">#{e.sequence}</span>
                    <span>{new Date(e.timestamp).toLocaleTimeString()}</span>
                    <span class="timeline-type">{e.type}</span>
                    <Show when={e.module?.name}>
                        <span class="timeline-mod">{e.module!.name}</span>
                    </Show>
                    <Show when={e.address}>
                        <span class="timeline-addr">{e.address}</span>
                    </Show>
                    <Show when={e.confidence !== "exact"}>
                        <span class="timeline-conf" title="This field is derived / a heuristic correlation, not an exact fact">{e.confidence}</span>
                    </Show>
                </div>
            </div>
        </div>
    );
}

function Inspector(props: { event: TimelineEvent; related: TimelineEvent[]; onSelect: (id: string) => void }) {
    const e = () => props.event;
    return (
        <div class="timeline-inspector">
            <div class="timeline-inspector-head">Event #{e().sequence}</div>
            <dl class="timeline-fields">
                <Field label="Summary" value={e().summary} />
                <Field label="Type" value={e().type} />
                <Field label="Source" value={e().source} />
                <Field label="Severity" value={e().severity} />
                <Field label="Confidence" value={e().confidence} />
                <Field label="Provenance" value={e().provenance} />
                <Field label="Time" value={e().timestamp} />
                <Field label="Generation" value={String(e().targetGeneration ?? "—")} />
                <Show when={e().processId !== undefined}><Field label="PID" value={String(e().processId)} /></Show>
                <Show when={e().module}><Field label="Module" value={`${e().module!.name}${e().module!.base ? ` @ ${e().module!.base}` : ""}`} /></Show>
                <Show when={e().address}><Field label="Address" value={e().address!} /></Show>
                <Show when={e().tags.length > 0}><Field label="Tags" value={e().tags.join(", ")} /></Show>
            </dl>
            <Show when={e().details !== undefined}>
                <div class="timeline-inspector-sub">Details</div>
                <pre class="timeline-details">{JSON.stringify(e().details, null, 2)}</pre>
            </Show>
            <Show when={props.related.length > 0}>
                <div class="timeline-inspector-sub">Related ({props.related.length})</div>
                <div class="timeline-related">
                    <For each={props.related}>
                        {(r) => (
                            <button class="timeline-related-item" onClick={() => props.onSelect(r.id)}>
                                <span class="timeline-sev" aria-hidden="true">{SEV_GLYPH[r.severity]}</span>
                                <span class="timeline-related-summary">{r.summary}</span>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}

function Field(props: { label: string; value: string }) {
    return (
        <>
            <dt>{props.label}</dt>
            <dd>{props.value}</dd>
        </>
    );
}
