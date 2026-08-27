import { batch as reactiveBatch, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { load, persist } from "./persist";
import type { AxClient } from "../transport/AxClient";
import { AxError } from "../transport/AxClient";
import { ErrorCode } from "../protocol/messages";
import { readBatch } from "../protocol/requests";
import type { ModuleEntry } from "../protocol/types";
import type { TimelineStore } from "../timeline/timelineStore";
import type { CapabilitiesStore } from "./capabilitiesStore";
import type { TargetSession } from "./targetSession";
import { TimelineEventType, jsonDetails, type TimelineEventInput } from "../timeline/events";
import {
    createWatch,
    freshRuntime,
    migrateDefinition,
    validateDefinition,
    watchReadSize,
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
    type CreateWatchInput,
    type DecodedWatchValue,
    type MemoryWatchDefinition,
    type MemoryWatchRuntime,
    type WatchError,
    type WatchErrorKind,
} from "../watch/model";
import { decodeForWatch } from "../watch/decode";
import { bytesChanged, computeDelta, evaluatePredicate } from "../watch/compare";
import { evaluateTrigger, freshTriggerRuntime, resetTriggerRuntime } from "../watch/triggers";
import { createWatchHistory, type WatchSample } from "../watch/history";
import { createWatchScheduler } from "../watch/scheduler";
import { planReadBatches, type WatchRead } from "../watch/readplan";
import * as csv from "../ui/csv";
import { makeModuleLookup, resolveWatchAddress } from "../watch/resolve";

// Memory Watch store: the integration hub. It owns serializable watch definitions (persisted),
// separate non-persisted runtime, a bounded history, a central scheduler, capability gating, and
// target-generation safety, and it emits honest timeline events (batched). Angel polling reads
// only — this can report that memory changed, never which instruction wrote it.

const STORAGE_KEY = "ax.watches";
const STORAGE_VERSION = 1;
const CHANGE_EVENT_MIN_MS = 1000; // per-watch floor between emitted change events (rest aggregated)
const MAX_CONSEC_BACKOFF = 6;

export type WatchAvailability = "available" | "assumed" | "paused" | "unavailable";

export interface WatchStoreDeps {
    client: AxClient;
    timeline: TimelineStore;
    capabilities: CapabilitiesStore;
    modules: Accessor<readonly ModuleEntry[]>;
    coreConnected: Accessor<boolean>;
    attached: Accessor<boolean>;
    liveKey: Accessor<string>;
    targetSession: TargetSession;
    now?: () => number; // injectable monotonic clock (tests)
}

interface ChangeThrottle {
    lastEventMs: number;
    coalesced: number;
    firstCoalescedIso?: string;
}

interface SchedulerMetrics {
    bytesRequested: number;
    bytesReceived: number;
    batches: number;
    failures: number;
    lastLatencyMs: number;
}

function clampInterval(ms: number): number {
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));
}

export function createWatchStore(deps: WatchStoreDeps) {
    const now = deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    const nowIso = () => new Date().toISOString();

    // --- persisted definitions ---
    const saved = load<{ watches: MemoryWatchDefinition[] }>(STORAGE_KEY, STORAGE_VERSION);
    const initial = (saved?.watches ?? []).map((w) => migrateDefinition(w)).filter((w): w is MemoryWatchDefinition => !!w);
    const [defs, setDefs] = createStore<{ list: MemoryWatchDefinition[] }>({ list: initial });
    persist(STORAGE_KEY, STORAGE_VERSION, () => ({ list: defs.list.map((w) => ({ ...w })) }));

    // --- non-persisted runtime ---
    const [rt, setRt] = createStore<{ map: Record<string, MemoryWatchRuntime> }>({ map: {} });
    // A saved watch is "pending" until explicitly armed against the current target (load safety):
    // never auto-poll old watches against a newly attached, unrelated process.
    const pending = new Set<string>(initial.map((w) => w.id));
    const throttle = new Map<string, ChangeThrottle>();
    const triggerRt = new Map<string, ReturnType<typeof freshTriggerRuntime>>();

    for (const w of initial) setRt("map", w.id, freshRuntime());

    const [globalPaused, setGlobalPaused] = createSignal(false);
    const [metrics, setMetrics] = createSignal<SchedulerMetrics>({ bytesRequested: 0, bytesReceived: 0, batches: 0, failures: 0, lastLatencyMs: 0 });
    // A version signal re-derives the schedulable set after arm/pending/import changes (which mutate
    // the plain `pending` Set, not a reactive source).
    const [pendingVersion, setPendingVersion] = createSignal(0);

    // Document visibility (pause polling when hidden). Guarded for non-DOM test envs.
    const [visible, setVisible] = createSignal(typeof document !== "undefined" ? !document.hidden : true);
    if (typeof document !== "undefined") {
        const onVis = () => setVisible(!document.hidden);
        document.addEventListener("visibilitychange", onVis);
        onCleanup(() => document.removeEventListener("visibilitychange", onVis));
    }

    const readAvailable = createMemo(() => deps.capabilities.available("memory.read"));
    const watchProvenance = createMemo(() => deps.capabilities.get("memory.watchPolling").provenance);

    const availability = createMemo<WatchAvailability>(() => {
        if (!readAvailable()) return "unavailable";
        if (globalPaused() || !deps.coreConnected() || !deps.attached() || !visible()) return "paused";
        if (watchProvenance() === "assumed") return "assumed";
        return "available";
    });

    const isActive = () => availability() === "available" || availability() === "assumed";

    // --- helpers ---
    const byId = (id: string): MemoryWatchDefinition | undefined => defs.list.find((w) => w.id === id);
    const runtime = (id: string): MemoryWatchRuntime => rt.map[id] ?? freshRuntime();
    const patchRt = (id: string, patch: Partial<MemoryWatchRuntime>) => setRt("map", id, (cur) => ({ ...(cur ?? freshRuntime()), ...patch }));

    const emit = (input: TimelineEventInput) => deps.timeline.ingest(input);

    function watchEvent(w: MemoryWatchDefinition, type: string, severity: TimelineEventInput["severity"], summary: string, extra?: Partial<TimelineEventInput>): TimelineEventInput {
        return {
            type,
            source: "memory",
            severity,
            summary,
            address: runtime(w.id).resolvedAddress,
            provenance: "Angel polling read",
            confidence: "exact",
            targetGeneration: deps.targetSession.generation(),
            tags: ["watch", ...w.tags],
            details: { watchId: w.id, name: w.name, expression: w.expression, valueType: w.valueType },
            ...extra,
        };
    }

    // --- scheduling inputs ---
    const effectiveInterval = (w: MemoryWatchDefinition): number => clampInterval(w.intervalMs);

    const schedulable = (): MemoryWatchDefinition[] =>
        defs.list.filter((w) => {
            if (!w.enabled || pending.has(w.id)) return false;
            const r = runtime(w.id);
            if (r.backoffUntilMs !== undefined && now() < r.backoffUntilMs) return false;
            return true;
        });

    const intervals = (): number[] => {
        pendingVersion(); // subscribe: re-derive when arm/pending/import changes
        const set = new Set<number>();
        for (const w of schedulable()) set.add(effectiveInterval(w));
        return [...set];
    };
    const bucketWatches = (ms: number): string[] => schedulable().filter((w) => effectiveInterval(w) === ms).map((w) => w.id);

    // --- the polling cycle ---
    async function runCycle(ids: string[], genAtStart: number): Promise<void> {
        if (deps.targetSession.isStale(genAtStart)) return; // captured a stale generation before we even read
        const lookup = makeModuleLookup(deps.modules().map((m) => ({ name: m.name, base: m.base })));
        const events: TimelineEventInput[] = [];

        // 1) resolve + collect reads; per-watch resolution errors fail only that watch. Resolved
        // addresses are applied with the read result (one store write per watch), not eagerly.
        const reads: WatchRead[] = [];
        const resolvedAddr = new Map<string, string>();
        reactiveBatch(() => {
            for (const id of ids) {
                const w = byId(id);
                if (!w) continue;
                const res = resolveWatchAddress(w.expression, lookup);
                if (!res.ok || !res.address) {
                    setWatchError(w, res.error?.includes("module") ? "moduleUnavailable" : "invalidExpression", res.error ?? "resolve failed", events);
                    continue;
                }
                const size = watchReadSize(w);
                if (!size || size <= 0) {
                    setWatchError(w, "unsupportedType", "no read size for type", events);
                    continue;
                }
                reads.push({ watchId: id, address: res.address, size });
                resolvedAddr.set(id, res.address);
            }
        });

        const { batches, oversize } = planReadBatches(reads);
        for (const o of oversize) {
            const w = byId(o.watchId);
            if (w) setWatchError(w, "oversized", `read size ${o.size} exceeds limit`, events);
        }

        // 2) execute batches sequentially; partial failure isolates per watch.
        let bytesReq = 0;
        let bytesRec = 0;
        let failures = 0;
        let lastLatency = 0;
        for (const batch of batches) {
            for (const e of batch.entries) bytesReq += e.size;
            const started = now();
            let results: Awaited<ReturnType<typeof readBatch>>["results"] | undefined;
            try {
                const reply = await readBatch(deps.client, { reads: batch.entries.map((e) => ({ address: e.address, size: e.size })) });
                results = reply.results;
            } catch (err) {
                // Definitive unsupported verb (defensive; core `read_batch` should exist) downgrades.
                if (err instanceof AxError) deps.capabilities.reportVerbError("read_batch", err);
                failures += 1;
                for (const entry of batch.entries) for (const id of entry.watchIds) {
                    const w = byId(id);
                    if (w) setWatchError(w, classifyError(err), errText(err), events);
                }
                continue;
            }
            lastLatency = now() - started;

            // Stale check AFTER the await: a target switch mid-flight discards results (never shown).
            if (deps.targetSession.isStale(genAtStart)) {
                for (const entry of batch.entries) for (const id of entry.watchIds) patchRt(id, { status: "stale" });
                continue;
            }

            // Coalesce all per-watch runtime writes for this batch into ONE reactive update, so 500
            // results do not fan out into 500 subscriber recomputations.
            reactiveBatch(() => {
                batch.entries.forEach((entry, i) => {
                    const rr = results![i];
                    for (const id of entry.watchIds) {
                        const w = byId(id);
                        if (!w) continue;
                        if (!rr || !rr.success) {
                            setWatchError(w, "unreadable", "read failed", events);
                            continue;
                        }
                        bytesRec += rr.data.length >> 1;
                        applyRead(w, rr.data, resolvedAddr.get(id), genAtStart, lastLatency, events);
                    }
                });
            });
        }

        setMetrics((m) => ({
            bytesRequested: m.bytesRequested + bytesReq,
            bytesReceived: m.bytesReceived + bytesRec,
            batches: m.batches + batches.length,
            failures: m.failures + failures,
            lastLatencyMs: lastLatency,
        }));

        if (events.length > 0) deps.timeline.ingestMany(events);
    }

    // Apply one successful read to a watch: decode, compare, update runtime, history, and events.
    function applyRead(w: MemoryWatchDefinition, dataHex: string, resolvedAddress: string | undefined, gen: number, latencyMs: number, events: TimelineEventInput[]): void {
        const decoded = decodeForWatch(dataHex, w);
        const prevRt = runtime(w.id);
        const wasError = prevRt.status === "error";
        const previous = prevRt.current;
        const changed = bytesChanged(previous, decoded);

        // change bookkeeping
        const nowIsoStr = nowIso();
        let changeCount = prevRt.changeCount;
        let firstChangedAt = prevRt.firstChangedAt;
        let lastChangedAt = prevRt.lastChangedAt;
        if (changed) {
            changeCount += 1;
            if (!firstChangedAt) firstChangedAt = nowIsoStr;
            lastChangedAt = nowIsoStr;
        }

        // predicate + trigger
        let matched = false;
        let triggered = false;
        if (w.predicate) {
            matched = evaluatePredicate(w.predicate, { valueType: w.valueType, current: decoded, previous, baseline: prevRt.baseline });
        }
        if (w.trigger) {
            const tr = triggerRt.get(w.id) ?? freshTriggerRuntime();
            const ev = evaluateTrigger(w.trigger, tr, matched, now());
            triggerRt.set(w.id, ev.runtime);
            triggered = ev.fire;
            if (triggered) {
                events.push(watchEvent(w, TimelineEventType.MemoryWatchTriggered, w.trigger.severity, `Trigger fired: ${w.name} (${w.predicate?.mode ?? "match"})`, {
                    details: jsonDetails({ watchId: w.id, name: w.name, predicate: w.predicate?.mode, value: decoded.display }),
                }));
                if (w.trigger.actions.includes("pauseWatch")) setEnabled(w.id, false, events);
                if (w.trigger.actions.includes("pauseAll")) setGlobalPaused(true);
            }
        }

        patchRt(w.id, {
            status: "ready",
            resolvedAddress: resolvedAddress ?? runtime(w.id).resolvedAddress,
            previous,
            current: decoded,
            lastReadAt: nowIsoStr,
            changeCount,
            firstChangedAt,
            lastChangedAt,
            consecutiveErrors: 0,
            backoffUntilMs: undefined,
            error: undefined,
            generation: gen,
            trigger: triggerRt.get(w.id),
        });

        // history sample
        pushSample(w, {
            timestamp: nowIsoStr,
            monotonicMs: now(),
            generation: gen,
            address: resolvedAddress ?? "0x0",
            bytesHex: decoded.bytesHex,
            display: decoded.display,
            changed,
            matched,
            triggered,
            latencyMs,
        });

        // recovered event once after an error clears
        if (wasError) {
            events.push(watchEvent(w, TimelineEventType.MemoryWatchRecovered, "info", `Watch recovered: ${w.name}`));
        }

        // changed event (rate-limited + aggregated)
        if (changed && (w.emitChangeEvents ?? true)) {
            maybeEmitChange(w, previous, decoded, events);
        }
    }

    function maybeEmitChange(w: MemoryWatchDefinition, prev: DecodedWatchValue | undefined, cur: DecodedWatchValue, events: TimelineEventInput[]): void {
        const t = throttle.get(w.id) ?? { lastEventMs: -Infinity, coalesced: 0 };
        const nowMs = now();
        if (nowMs - t.lastEventMs >= CHANGE_EVENT_MIN_MS) {
            const aggregated = t.coalesced;
            events.push(
                watchEvent(w, TimelineEventType.MemoryWatchChanged, "info", `${w.name}: ${prev?.display ?? "—"} -> ${cur.display}`, {
                    details: jsonDetails({
                        watchId: w.id,
                        name: w.name,
                        expression: w.expression,
                        resolvedAddress: runtime(w.id).resolvedAddress,
                        valueType: w.valueType,
                        previous: prev?.display,
                        current: cur.display,
                        baseline: runtime(w.id).baseline?.display,
                        comparison: w.predicate?.mode,
                        delta: computeDelta(cur, prev),
                        ...(aggregated > 0 ? { coalescedChanges: aggregated, coalescedSince: t.firstCoalescedIso } : {}),
                    }),
                }),
            );
            throttle.set(w.id, { lastEventMs: nowMs, coalesced: 0 });
        } else {
            throttle.set(w.id, { lastEventMs: t.lastEventMs, coalesced: t.coalesced + 1, firstCoalescedIso: t.firstCoalescedIso ?? nowIso() });
        }
    }

    function pushSample(w: MemoryWatchDefinition, s: Omit<WatchSample, "seq">): void {
        history.push(w.id, s, w.historyLimit);
        bumpHistory((n) => n + 1);
    }

    function setWatchError(w: MemoryWatchDefinition, kind: WatchErrorKind, message: string, events: TimelineEventInput[]): void {
        const prev = runtime(w.id);
        const wasError = prev.status === "error";
        const consec = prev.consecutiveErrors + 1;
        const base = Math.max(effectiveInterval(w), 500);
        const backoff = base * 2 ** Math.min(consec - 1, MAX_CONSEC_BACKOFF);
        const err: WatchError = { kind, message, at: nowIso() };
        patchRt(w.id, { status: "error", consecutiveErrors: consec, backoffUntilMs: now() + backoff, error: err });
        // Emit only on transition into error or a changed error kind (avoid spam).
        if (!wasError || prev.error?.kind !== kind) {
            events.push(watchEvent(w, TimelineEventType.MemoryWatchError, "warning", `Watch error (${kind}): ${w.name}`, { details: { watchId: w.id, kind, message } }));
        }
    }

    function classifyError(err: unknown): WatchErrorKind {
        if (err instanceof AxError) {
            if (err.code === ErrorCode.NotAttached) return "detached";
            if (err.code === ErrorCode.ReadFailed) return "unreadable";
            if (err.code === ErrorCode.SizeOutOfRange) return "oversized";
            return "unreadable";
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("timed out")) return "timeout";
        if (msg.includes("not connected") || msg.includes("closed")) return "coreDisconnected";
        return "unreadable";
    }
    const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

    // --- history ---
    const history = createWatchHistory();
    const [historyVersion, bumpHistory] = createSignal(0, { equals: false });

    // --- scheduler ---
    const scheduler = createWatchScheduler({
        intervals,
        bucketWatches,
        runCycle,
        generation: deps.targetSession.generation,
        isActive,
        setTimer: (fn, ms) => setInterval(fn, ms),
        clearTimer: (h) => clearInterval(h),
    });
    scheduler.start();
    onCleanup(() => scheduler.stop());
    // Reconcile timers whenever the schedulable set / intervals change.
    createEffect(() => {
        intervals(); // track
        scheduler.sync();
    });

    // --- public CRUD ---
    function add(input: CreateWatchInput): string {
        const w = createWatch({ ...input, targetKey: deps.liveKey(), nowIso: nowIso() });
        setDefs("list", (l) => [...l, w]);
        setRt("map", w.id, freshRuntime());
        emit(watchEvent(w, TimelineEventType.MemoryWatchCreated, "info", `Watch created: ${w.name}`));
        scheduler.sync();
        return w.id;
    }

    function update(id: string, patch: Partial<MemoryWatchDefinition>): void {
        const w = byId(id);
        if (!w) return;
        const next = { ...w, ...patch, updatedAt: nowIso() };
        const v = validateDefinition(next);
        if (!v.ok) return;
        // If address/type changed, reset incompatible runtime data (previous/baseline no longer valid).
        const structural = patch.expression !== undefined || patch.valueType !== undefined || patch.byteLength !== undefined || patch.endianness !== undefined;
        setDefs("list", (l) => l.map((x) => (x.id === id ? next : x)));
        if (structural) patchRt(id, { previous: undefined, current: undefined, baseline: undefined, changeCount: 0, status: "idle" });
        emit(watchEvent(next, TimelineEventType.MemoryWatchUpdated, "debug", `Watch updated: ${next.name}`));
        scheduler.sync();
    }

    function remove(id: string): void {
        const w = byId(id);
        setDefs("list", (l) => l.filter((x) => x.id !== id));
        setRt("map", produce((m) => { delete m[id]; }));
        history.clear(id);
        throttle.delete(id);
        triggerRt.delete(id);
        pending.delete(id);
        if (w) emit(watchEvent(w, TimelineEventType.MemoryWatchRemoved, "debug", `Watch removed: ${w.name}`));
        scheduler.sync();
    }

    function setEnabled(id: string, on: boolean, batchEvents?: TimelineEventInput[]): void {
        const w = byId(id);
        if (!w) return;
        setDefs("list", (l) => l.map((x) => (x.id === id ? { ...x, enabled: on } : x)));
        if (!on) patchRt(id, { status: "paused" });
        const ev = watchEvent(w, on ? TimelineEventType.MemoryWatchEnabled : TimelineEventType.MemoryWatchDisabled, "debug", `${on ? "Enabled" : "Disabled"}: ${w.name}`);
        if (batchEvents) batchEvents.push(ev);
        else emit(ev);
        scheduler.sync();
    }

    function captureBaseline(id: string): void {
        const w = byId(id);
        const cur = runtime(id).current;
        if (!w || !cur?.ok) return;
        patchRt(id, { baseline: cur });
        emit(watchEvent(w, TimelineEventType.MemoryWatchBaselineCaptured, "info", `Baseline captured: ${w.name} = ${cur.display}`));
    }
    function captureAllBaselines(): void {
        for (const w of defs.list) if (runtime(w.id).current?.ok) captureBaseline(w.id);
    }

    function resetTrigger(id: string): void {
        const cur = triggerRt.get(id);
        if (cur) triggerRt.set(id, resetTriggerRuntime(cur));
        patchRt(id, { trigger: triggerRt.get(id) });
    }

    // Arm a saved (pending) watch against the current target so it may begin polling.
    function arm(id: string): void {
        pending.delete(id);
        const w = byId(id);
        if (w) setDefs("list", (l) => l.map((x) => (x.id === id ? { ...x, targetKey: deps.liveKey() } : x)));
        patchRt(id, { status: "idle" });
        setPendingVersion((n) => n + 1);
        scheduler.sync();
    }
    function armAllForCurrentTarget(): void {
        for (const id of [...pending]) arm(id);
    }
    const isPending = (id: string): boolean => pending.has(id);

    function pauseAll(): void {
        setGlobalPaused(true);
        deps.timeline.ingest({ type: TimelineEventType.MemoryWatchPaused, source: "memory", severity: "notice", summary: "All watches paused", provenance: "user", confidence: "exact", tags: ["watch"] });
    }
    function resumeAll(): void {
        setGlobalPaused(false);
        deps.timeline.ingest({ type: TimelineEventType.MemoryWatchResumed, source: "memory", severity: "info", summary: "All watches resumed", provenance: "user", confidence: "exact", tags: ["watch"] });
    }

    const readNow = (ids: string[]) => scheduler.readNow(ids.filter((id) => !pending.has(id)));
    const readNowAll = () => readNow(defs.list.filter((w) => w.enabled).map((w) => w.id));

    // --- history access (reactive via historyVersion) ---
    const historyOf = (id: string): readonly WatchSample[] => (historyVersion(), history.get(id));
    const historySegmentsOf = (id: string) => (historyVersion(), history.segments(id));
    const historyDroppedOf = (id: string) => (historyVersion(), history.droppedFor(id));
    function clearHistory(id: string): void { history.clear(id); bumpHistory((n) => n + 1); }
    function clearAllHistory(): void { history.clearAll(); bumpHistory((n) => n + 1); }

    // --- import / export ---
    function exportDefinitions(ids?: string[]): string {
        const list = ids ? defs.list.filter((w) => ids.includes(w.id)) : defs.list;
        return JSON.stringify({ schemaVersion: STORAGE_VERSION, watches: list }, null, 2);
    }
    type ImportMode = "keepBoth" | "replace" | "skip";
    function importDefinitions(text: string, mode: ImportMode = "keepBoth"): number {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw new Error("watch import: not valid JSON"); }
        const arr = (parsed as { watches?: unknown }).watches;
        if (!Array.isArray(arr)) throw new Error("watch import: missing watches array");
        let added = 0;
        for (const raw of arr) {
            const w = migrateDefinition(raw);
            if (!w) continue;
            const dupe = defs.list.find((x) => x.expression === w.expression && x.valueType === w.valueType);
            if (dupe && mode === "skip") continue;
            if (dupe && mode === "replace") { update(dupe.id, w); continue; }
            // Imported watches load pending (never auto-poll against the current process) and never write.
            const imported: MemoryWatchDefinition = { ...w, id: createWatch({ expression: w.expression }).id, enabled: w.enabled, targetKey: undefined };
            setDefs("list", (l) => [...l, imported]);
            setRt("map", imported.id, freshRuntime());
            pending.add(imported.id);
            added += 1;
        }
        setPendingVersion((n) => n + 1);
        scheduler.sync();
        return added;
    }
    function exportHistoryJSON(id: string): string {
        return JSON.stringify({ watchId: id, samples: history.get(id) }, null, 2);
    }
    function exportHistoryCSV(id: string): string {
        // RFC-4180 via the shared serializer. `display` is target-derived text → formula-guarded; the
        // rest are numeric/canonical. (Previously JSON.stringify'd display → invalid CSV on quotes.)
        const rows = history.get(id).map((s) => [
            csv.num(s.seq),
            csv.raw(s.timestamp),
            csv.num(s.generation),
            csv.raw(s.address),
            csv.text(s.display),
            csv.raw(s.changed ? "true" : "false"),
            s.latencyMs === undefined ? csv.raw("") : csv.num(s.latencyMs),
        ]);
        return csv.serializeCsv(rows, { header: ["seq", "timestamp", "generation", "address", "display", "changed", "latencyMs"] });
    }

    return {
        definitions: () => defs.list,
        runtime,
        byId,
        add,
        update,
        remove,
        setEnabled: (id: string, on: boolean) => setEnabled(id, on),
        captureBaseline,
        captureAllBaselines,
        resetTrigger,
        arm,
        armAllForCurrentTarget,
        isPending,
        pauseAll,
        resumeAll,
        globalPaused,
        readNow,
        readNowAll,
        historyOf,
        historySegmentsOf,
        historyDroppedOf,
        clearHistory,
        clearAllHistory,
        exportDefinitions,
        importDefinitions,
        exportHistoryJSON,
        exportHistoryCSV,
        availability,
        metrics,
        schedulerBuckets: () => scheduler.bucketCount(),
        // capability gating readouts
        readAvailable,
        watchProvenance,
    };
}

export type WatchStore = ReturnType<typeof createWatchStore>;
