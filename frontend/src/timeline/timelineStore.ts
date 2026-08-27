import { createMemo, createSignal } from "solid-js";
import {
    CURRENT_EVENT_SCHEMA_VERSION,
    SEVERITY_ORDER,
    timelineExportSchema,
    type TimelineEvent,
    type TimelineEventInput,
    type TimelineEventSeverity,
    type TimelineEventSource,
} from "./events";

// Central event ingestion + bounded store for the unified timeline. Producers push typed events;
// the store owns identity (id + monotonic sequence), retention (a bounded ring — oldest dropped),
// target-generation stamping/isolation, filtering/grouping/selection, lightweight correlation, and
// JSON export/import. It never reaches into any producer's store — producers hand it finished events.

// Bounded retention: the timeline is a rolling window, never an unbounded log. Oldest events are
// dropped once the cap is hit; `dropped` counts them so the UI can show an honest truncation marker.
export const MAX_TIMELINE_EVENTS = 5000;

function now(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
}

function nowIso(): string {
    return new Date().toISOString();
}

// --- Pure filtering / grouping (exported for tests + reuse) ------------------

export interface TimelineFilter {
    sources?: TimelineEventSource[]; // empty/undefined = all sources
    types?: string[]; // exact type match; empty/undefined = all types
    minSeverity?: TimelineEventSeverity; // inclusive floor
    text?: string; // case-insensitive match over summary/type/module/address/tags
    generation?: number | "current" | "all"; // target-generation scope
}

export function eventMatchesFilter(
    ev: TimelineEvent,
    filter: TimelineFilter,
    currentGeneration: number,
): boolean {
    if (filter.sources && filter.sources.length > 0 && !filter.sources.includes(ev.source)) return false;
    if (filter.types && filter.types.length > 0 && !filter.types.includes(ev.type)) return false;
    if (filter.minSeverity && SEVERITY_ORDER[ev.severity] < SEVERITY_ORDER[filter.minSeverity]) return false;

    const gen = filter.generation ?? "all";
    if (gen === "current") {
        if (ev.targetGeneration !== currentGeneration) return false;
    } else if (typeof gen === "number") {
        if (ev.targetGeneration !== gen) return false;
    }

    const q = filter.text?.trim().toLowerCase();
    if (q) {
        const hay = [
            ev.summary,
            ev.type,
            ev.module?.name ?? "",
            ev.address ?? "",
            ev.provenance,
            ...ev.tags,
        ]
            .join(" ")
            .toLowerCase();
        if (!hay.includes(q)) return false;
    }
    return true;
}

export function filterEvents(
    events: readonly TimelineEvent[],
    filter: TimelineFilter,
    currentGeneration: number,
): TimelineEvent[] {
    return events.filter((e) => eventMatchesFilter(e, filter, currentGeneration));
}

export type TimelineGroupBy = "none" | "source" | "type" | "generation" | "severity";

export interface TimelineGroup {
    key: string;
    events: TimelineEvent[];
}

export function groupEvents(events: readonly TimelineEvent[], by: TimelineGroupBy): TimelineGroup[] {
    if (by === "none") return [{ key: "", events: [...events] }];
    const map = new Map<string, TimelineEvent[]>();
    for (const e of events) {
        const key =
            by === "source"
                ? e.source
                : by === "type"
                  ? e.type
                  : by === "severity"
                    ? e.severity
                    : String(e.targetGeneration ?? "—");
        let bucket = map.get(key);
        if (!bucket) map.set(key, (bucket = []));
        bucket.push(e);
    }
    return [...map.entries()].map(([key, evs]) => ({ key, events: evs }));
}

// --- Store ------------------------------------------------------------------

// How much dead head slack accumulates before the backing array is compacted. Keeps ingest O(1)
// amortized (a plain push) while the strict logical cap stays exactly MAX_TIMELINE_EVENTS: a Solid
// store proxy + per-event splice was O(n) per ingest, quadratic under a burst.
const COMPACT_SLACK = 2048;

export function createTimelineStore() {
    // Plain array + a version signal, rather than a Solid store: the timeline is an append-heavy log,
    // and fine-grained proxy reconciliation on every push is far too costly. `head` is the index of
    // the oldest live event; events before it are logically dropped and physically reclaimed on
    // compaction. Reactive readers depend on `version`.
    let buffer: TimelineEvent[] = [];
    let head = 0;
    const [version, setVersion] = createSignal(0);
    const [dropped, setDropped] = createSignal(0);
    const [currentGeneration, setCurrentGeneration] = createSignal(0);
    const [selectedId, setSelectedId] = createSignal<string | null>(null);
    const [filter, setFilter] = createSignal<TimelineFilter>({});
    const [groupBy, setGroupBy] = createSignal<TimelineGroupBy>("none");

    let seq = 0;

    const touch = () => setVersion((v) => v + 1);
    // The live slice (oldest→newest). Non-reactive; wrap in liveEvents() for reactive reads.
    const slice = (): TimelineEvent[] => (head === 0 ? buffer : buffer.slice(head));
    const liveEvents = (): TimelineEvent[] => {
        version();
        return slice();
    };

    function push(ev: TimelineEvent): void {
        buffer.push(ev);
        if (buffer.length - head > MAX_TIMELINE_EVENTS) {
            head += 1;
            setDropped((d) => d + 1);
        }
        if (head > COMPACT_SLACK) {
            buffer = buffer.slice(head);
            head = 0;
        }
    }

    function build(input: TimelineEventInput): TimelineEvent {
        seq += 1;
        return {
            schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
            id: `ev_${seq}`,
            sequence: seq,
            type: input.type,
            source: input.source,
            timestamp: input.timestamp ?? nowIso(),
            monotonicMs: input.monotonicMs ?? now(),
            targetGeneration: input.targetGeneration ?? currentGeneration(),
            processId: input.processId,
            threadId: input.threadId,
            module: input.module,
            address: input.address,
            size: input.size,
            severity: input.severity,
            summary: input.summary,
            tags: input.tags ?? [],
            relatedEventIds: input.relatedEventIds ?? [],
            confidence: input.confidence ?? "exact",
            provenance: input.provenance ?? `source:${input.source}`,
            details: input.details,
        };
    }

    function ingest(input: TimelineEventInput): TimelineEvent {
        const ev = build(input);
        push(ev);
        touch();
        return ev;
    }

    // Batch ingestion for high-frequency producers (e.g. a 500-watch polling cycle): all events are
    // built and pushed, retention applied per push, but the reactive version bumps exactly ONCE — so
    // one polling result never triggers N full timeline recomputations. Order is deterministic
    // (sequence increments in array order). Each input keeps whatever targetGeneration the producer
    // stamped (falling back to the current generation), so a cycle's captured generation is preserved.
    function ingestMany(inputs: readonly TimelineEventInput[]): TimelineEvent[] {
        if (inputs.length === 0) return [];
        const built: TimelineEvent[] = [];
        for (const input of inputs) {
            const ev = build(input);
            built.push(ev);
            push(ev);
        }
        touch();
        return built;
    }

    // Target-generation isolation: producers set the current generation when the attached process
    // changes; subsequent events are stamped with it, and the timeline can scope to it.
    function setGeneration(gen: number): void {
        setCurrentGeneration(gen);
    }

    // Lightweight correlation: bidirectionally link two events so the inspector can jump between
    // related evidence. Heuristic correlation across producers is marked via each event's confidence.
    function link(aId: string, bId: string): void {
        if (aId === bId) return;
        const a = byId(aId);
        const b = byId(bId);
        if (!a || !b) return;
        if (!a.relatedEventIds.includes(bId)) a.relatedEventIds.push(bId);
        if (!b.relatedEventIds.includes(aId)) b.relatedEventIds.push(aId);
        touch();
    }

    function byId(id: string): TimelineEvent | undefined {
        for (let i = head; i < buffer.length; i++) if (buffer[i].id === id) return buffer[i];
        return undefined;
    }

    // Events related to `id`: those it names, plus those that name it (union, deduped).
    function related(id: string): TimelineEvent[] {
        const ev = byId(id);
        if (!ev) return [];
        const ids = new Set(ev.relatedEventIds);
        const live = slice();
        for (const e of live) if (e.relatedEventIds.includes(id)) ids.add(e.id);
        return live.filter((e) => ids.has(e.id));
    }

    const filtered = createMemo(() => filterEvents(liveEvents(), filter(), currentGeneration()));
    const groups = createMemo(() => groupEvents(filtered(), groupBy()));

    // --- Export / import ----------------------------------------------------

    function exportJSON(): string {
        return JSON.stringify(
            { schemaVersion: CURRENT_EVENT_SCHEMA_VERSION, exportedAt: nowIso(), events: slice() },
            null,
            2,
        );
    }

    // Merge imported events. Ids are remapped to fresh unique ids (relatedEventIds remapped in step,
    // so intra-export links survive) and tagged "imported". A version/shape mismatch throws — no
    // partial import. Returns the number of events added.
    function importJSON(text: string): number {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error("timeline import: not valid JSON");
        }
        const result = timelineExportSchema.safeParse(parsed);
        if (!result.success) {
            throw new Error(`timeline import: schema mismatch (${result.error.issues[0]?.message ?? "invalid"})`);
        }
        const incoming = result.data.events;
        const idMap = new Map<string, string>();
        for (const e of incoming) idMap.set(e.id, `ev_${(seq += 1)}`);

        for (const e of incoming) {
            const newId = idMap.get(e.id)!;
            push({
                ...e,
                id: newId,
                sequence: Number(newId.slice(3)),
                relatedEventIds: e.relatedEventIds.map((r) => idMap.get(r) ?? r),
                tags: e.tags.includes("imported") ? e.tags : [...e.tags, "imported"],
            });
        }
        touch();
        return incoming.length;
    }

    function clear(): void {
        buffer = [];
        head = 0;
        setSelectedId(null);
        touch();
    }

    return {
        get events() {
            return liveEvents();
        },
        ingest,
        ingestMany,
        filtered,
        groups,
        dropped,
        count: () => {
            version();
            return buffer.length - head;
        },
        currentGeneration,
        setGeneration,
        // selection
        selectedId,
        selected: (): TimelineEvent | undefined => {
            const id = selectedId();
            return id ? byId(id) : undefined;
        },
        select: (id: string | null) => setSelectedId(id),
        byId,
        related,
        link,
        // filter / grouping
        filter,
        setFilter,
        groupBy,
        setGroupBy,
        // io
        exportJSON,
        importJSON,
        clear,
    };
}

export type TimelineStore = ReturnType<typeof createTimelineStore>;
