import { For, Show, type Accessor } from "solid-js";
import { FILTER_MODES, type FilterMode } from "../nodes/filter";
import { PREVIEW_BUDGETS, PREVIEW_MODES, REFRESH_INTERVALS, type PreviewMode } from "../state/viewerSettings";

// The memory viewer's live-inspection + search toolbar: two compact rows above the grid.
// Row 1: poll status/pause/refresh/interval, baseline capture/compare, pointer-preview policy.
// Row 2: search, field filters, go-to-offset, and the controlled-analysis actions.
// Purely presentational - every piece of state lives in MemoryView / the stores.

export type PollStatus = "live" | "paused" | "reading" | "error";

export interface ToolbarProps {
    status: Accessor<PollStatus>;
    statusDetail: Accessor<string | undefined>;

    paused: Accessor<boolean>;
    onTogglePause: () => void;
    onRefreshOnce: () => void;

    intervalMs: Accessor<number>;
    onInterval: (ms: number) => void;

    hasBaseline: Accessor<boolean>;
    hasSnapshot: Accessor<boolean>;
    onCaptureBaseline: () => void;
    onClearBaseline: () => void;
    changedOnly: Accessor<boolean>;
    onToggleChangedOnly: () => void;

    previewMode: Accessor<PreviewMode>;
    onPreviewMode: (mode: PreviewMode) => void;
    maxPreviews: Accessor<number>;
    onMaxPreviews: (n: number) => void;
    /** Eligible pointer previews skipped this cycle because the budget was exceeded. */
    previewSkipped: Accessor<number>;

    query: Accessor<string>;
    onQuery: (q: string) => void;
    filter: Accessor<FilterMode>;
    onFilter: (mode: FilterMode) => void;
    resultCount: Accessor<number>;
    totalCount: Accessor<number>;
    onClearFilters: () => void;
    onGoto: (text: string) => void;

    autoGuess: Accessor<boolean>;
    onToggleAutoGuess: () => void;
    autoGrow: Accessor<boolean>;
    onToggleAutoGrow: () => void;
    onAnalyze: () => void;
    analyzing: Accessor<boolean>;
    suggestionCount: Accessor<number>;
    selectedSuggestionCount: Accessor<number>;
    onAcceptAllSuggestions: () => void;
    onAcceptSelectedSuggestions: () => void;
    onRejectSuggestions: () => void;
}

const STATUS_LABEL: Record<PollStatus, string> = {
    live: "Live",
    paused: "Paused",
    reading: "Reading",
    error: "Error",
};

export function MemoryToolbar(props: ToolbarProps) {
    const filtered = () => props.query().trim() !== "" || props.filter() !== "all";

    return (
        <div class="mem-toolbar" role="toolbar" aria-label="memory viewer controls">
            <div class="mem-toolbar-row">
                <span class={`mem-status mem-status-${props.status()}`} title={props.statusDetail()}>
                    {STATUS_LABEL[props.status()]}
                </span>

                <button
                    class="mtb-btn"
                    onClick={() => props.onTogglePause()}
                    title={props.paused() ? "resume live polling" : "pause live polling (freezes the snapshot)"}
                    aria-pressed={props.paused()}
                >
                    {props.paused() ? "▶ Resume" : "⏸ Pause"}
                </button>
                <button
                    class="mtb-btn"
                    onClick={() => props.onRefreshOnce()}
                    disabled={!props.paused()}
                    title="read the region once without resuming"
                >
                    ↻ Once
                </button>

                <label class="mtb-field">
                    <span class="mtb-label">every</span>
                    <select
                        class="mtb-select"
                        value={String(props.intervalMs())}
                        onChange={(e) => props.onInterval(Number(e.currentTarget.value))}
                        aria-label="refresh interval"
                    >
                        <For each={REFRESH_INTERVALS}>{(ms) => <option value={String(ms)}>{ms} ms</option>}</For>
                    </select>
                </label>

                <span class="mtb-sep" />

                <button
                    class="mtb-btn"
                    onClick={() => props.onCaptureBaseline()}
                    disabled={!props.hasSnapshot()}
                    title="capture the current snapshot as the comparison baseline"
                >
                    ⊙ Baseline
                </button>
                <button
                    class="mtb-btn"
                    onClick={() => props.onClearBaseline()}
                    disabled={!props.hasBaseline()}
                    title="clear the captured baseline"
                >
                    ✕
                </button>
                <button
                    class="mtb-btn toggle"
                    classList={{ on: props.changedOnly() }}
                    onClick={() => props.onToggleChangedOnly()}
                    disabled={!props.hasBaseline()}
                    title={props.hasBaseline() ? "show only fields changed from the baseline" : "capture a baseline first"}
                    aria-pressed={props.changedOnly()}
                >
                    Changed only
                </button>

                <span class="mtb-sep" />

                <label class="mtb-field">
                    <span class="mtb-label">previews</span>
                    <select
                        class="mtb-select"
                        value={props.previewMode()}
                        onChange={(e) => props.onPreviewMode(e.currentTarget.value as PreviewMode)}
                        aria-label="pointer preview mode"
                    >
                        <For each={PREVIEW_MODES}>{(m) => <option value={m.id}>{m.label}</option>}</For>
                    </select>
                </label>
                <label class="mtb-field">
                    <span class="mtb-label">max</span>
                    <select
                        class="mtb-select"
                        value={String(props.maxPreviews())}
                        onChange={(e) => props.onMaxPreviews(Number(e.currentTarget.value))}
                        aria-label="max pointer previews per cycle"
                    >
                        <For each={PREVIEW_BUDGETS}>{(n) => <option value={String(n)}>{n}</option>}</For>
                    </select>
                </label>
                <Show when={props.previewSkipped() > 0}>
                    <span class="mtb-note warn" title="pointer previews skipped this cycle - raise the budget or narrow the mode">
                        {props.previewSkipped()} throttled
                    </span>
                </Show>
            </div>

            <div class="mem-toolbar-row">
                <input
                    class="mtb-search"
                    type="text"
                    placeholder="search name / offset / address / value / type"
                    value={props.query()}
                    onInput={(e) => props.onQuery(e.currentTarget.value)}
                    aria-label="search fields"
                />
                <select
                    class="mtb-select"
                    value={props.filter()}
                    onChange={(e) => props.onFilter(e.currentTarget.value as FilterMode)}
                    aria-label="field filter"
                >
                    <For each={FILTER_MODES}>
                        {(m) => (
                            <option value={m.id} disabled={m.id === "changed" && !props.hasBaseline()}>
                                {m.label}
                            </option>
                        )}
                    </For>
                </select>
                <span class="mtb-note" aria-live="polite">
                    {filtered() ? `${props.resultCount()} / ${props.totalCount()}` : `${props.totalCount()} fields`}
                </span>
                <Show when={filtered()}>
                    <button class="mtb-btn" onClick={() => props.onClearFilters()} title="clear search and filter">
                        Clear
                    </button>
                </Show>

                <input
                    class="mtb-goto"
                    type="text"
                    placeholder="goto 0x…"
                    aria-label="go to offset"
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            props.onGoto(e.currentTarget.value);
                            e.currentTarget.select();
                        }
                    }}
                />

                <span class="mtb-sep" />

                <button
                    class="mtb-btn toggle"
                    classList={{ on: props.autoGuess() }}
                    onClick={() => props.onToggleAutoGuess()}
                    title="automatically apply high-confidence type guesses to untyped bytes"
                    aria-pressed={props.autoGuess()}
                >
                    Auto guess
                </button>
                <button
                    class="mtb-btn toggle"
                    classList={{ on: props.autoGrow() }}
                    onClick={() => props.onToggleAutoGrow()}
                    title="automatically extend the class with padding when typed data reaches its end (max 0x1000 bytes)"
                    aria-pressed={props.autoGrow()}
                >
                    Auto grow
                </button>
                <button
                    class="mtb-btn"
                    onClick={() => props.onAnalyze()}
                    disabled={props.analyzing() || !props.hasSnapshot()}
                    title="classify every untyped field once and stage the results for review"
                >
                    {props.analyzing() ? "Analyzing…" : "⚛ Analyze"}
                </button>

                <Show when={props.suggestionCount() > 0}>
                    <span class="mtb-note accent">{props.suggestionCount()} suggested</span>
                    <button class="mtb-btn" onClick={() => props.onAcceptAllSuggestions()} title="apply every pending suggestion">
                        Accept all
                    </button>
                    <Show when={props.selectedSuggestionCount() > 0}>
                        <button
                            class="mtb-btn"
                            onClick={() => props.onAcceptSelectedSuggestions()}
                            title="apply pending suggestions on the selected rows"
                        >
                            Accept sel ({props.selectedSuggestionCount()})
                        </button>
                    </Show>
                    <button class="mtb-btn" onClick={() => props.onRejectSuggestions()} title="discard all pending suggestions">
                        Reject
                    </button>
                </Show>
            </div>
        </div>
    );
}
