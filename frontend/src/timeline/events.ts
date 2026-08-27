import { z } from "zod";

// Versioned, shared event model for the unified timeline. This is deliberately provider-agnostic:
// the timeline store and view depend ONLY on the common base fields below, never on any producer's
// own store or payload shape. Future providers (Memory Watch, emulator trace, scanner, patches,
// network, ...) add new `type` strings and put their specifics in `details` — no coupling required.
//
// Honesty note: an event's existence never implies a capability the backend lacks. Producers only
// emit for activity that actually happened (a socket opened, a target attached, a module list
// loaded). `confidence` marks whether a field is exact, derived, or a heuristic correlation.

export const CURRENT_EVENT_SCHEMA_VERSION = 1 as const;

export type TimelineEventSeverity = "debug" | "info" | "notice" | "warning" | "error";
export type TimelineEventConfidence = "exact" | "derived" | "heuristic";

// The producing subsystem. Closed set so the timeline can offer stable source filters; extending it
// is a deliberate, reviewed change (add here + a producer). Payload specifics stay in `details`.
export type TimelineEventSource =
    | "session"
    | "relay"
    | "agent"
    | "capability"
    | "target"
    | "module"
    | "memory"
    | "scanner"
    | "emulator"
    | "patch"
    | "network"
    | "decompiler"
    | "user";

// Known event types produced today. `type` is an open string so future providers add their own
// without editing this file; these constants keep today's producers consistent and greppable.
export const TimelineEventType = {
    SessionStart: "session.start",
    RelayStatus: "relay.status",
    AgentCoreStatus: "agent.core.status",
    AgentExtStatus: "agent.ext.status",
    CapabilityNegotiated: "capability.negotiated",
    CapabilityDowngraded: "capability.downgraded",
    TargetAttached: "target.attached",
    TargetDetached: "target.detached",
    TargetGeneration: "target.generation",
    ModuleListLoaded: "module.listLoaded",
    UserAnnotation: "user.annotation",
    // Memory Watch (Phase 2). Angel polling reads only — never a debugger watchpoint / writer id.
    MemoryWatchCreated: "memory.watch.created",
    MemoryWatchUpdated: "memory.watch.updated",
    MemoryWatchRemoved: "memory.watch.removed",
    MemoryWatchEnabled: "memory.watch.enabled",
    MemoryWatchDisabled: "memory.watch.disabled",
    MemoryWatchChanged: "memory.watch.changed",
    MemoryWatchTriggered: "memory.watch.triggered",
    MemoryWatchError: "memory.watch.error",
    MemoryWatchRecovered: "memory.watch.recovered",
    MemoryWatchBaselineCaptured: "memory.watch.baselineCaptured",
    MemoryWatchPaused: "memory.watch.paused",
    MemoryWatchResumed: "memory.watch.resumed",
    // Unicorn emulator (Phase 3). Offline/process-backed emulation — never live process behavior.
    EmulatorSessionCreated: "emulator.session.created",
    EmulatorSessionReset: "emulator.session.reset",
    EmulatorSessionClosed: "emulator.session.closed",
    EmulatorSessionStale: "emulator.session.stale",
    EmulatorRunStarted: "emulator.run.started",
    EmulatorRunCompleted: "emulator.run.completed",
    EmulatorRunStopped: "emulator.run.stopped",
    EmulatorRunFaulted: "emulator.run.faulted",
    EmulatorBreakpointHit: "emulator.breakpoint.hit",
    EmulatorTraceTruncated: "emulator.trace.truncated",
    EmulatorRegisterChanged: "emulator.register.changed",
    EmulatorMemoryChanged: "emulator.memory.changed",
    // Patch workspace (Phase 7). Angel `write` verb — original bytes always retained.
    PatchCreated: "patch.created",
    PatchRemoved: "patch.removed",
    PatchApplied: "patch.applied",
    PatchRestored: "patch.restored",
    PatchFailed: "patch.failed",
    PatchStale: "patch.stale",
    // Ghidra decompiler (Phase 15). Optional local sidecar — static analysis, provenance Ghidra.
    DecompilerJobStarted: "decompiler.job.started", // module METADATA analysis (no per-function events)
    DecompilerJobCompleted: "decompiler.job.completed",
    DecompilerJobFailed: "decompiler.job.failed",
    // Explicit single-function decompilation (Phase 15.1) — only real, user-initiated operations.
    DecompileStarted: "analysis.ghidra.decompileStarted",
    DecompileCompleted: "analysis.ghidra.decompileCompleted",
    DecompileFailed: "analysis.ghidra.decompileFailed",
    DecompileCancelled: "analysis.ghidra.decompileCancelled",
    DecompileCacheHit: "analysis.ghidra.decompileCacheHit",
    // Offline PCAP analysis (tshark sidecar). SUMMARY events only — never one event per packet. These
    // are NOT correlated to the attached target; provenance is "tshark offline PCAP analysis".
    PcapImportStarted: "network.pcap.importStarted",
    PcapImportCompleted: "network.pcap.importCompleted",
    PcapImportFailed: "network.pcap.importFailed",
    PcapImportCancelled: "network.pcap.importCancelled",
    PcapFilterApplied: "network.pcap.filterApplied",
    PcapStreamFollowed: "network.pcap.streamFollowed",
    PcapTruncated: "network.pcap.truncated",
    PcapCacheHit: "network.pcap.cacheHit",
} as const;
export type TimelineEventTypeValue = (typeof TimelineEventType)[keyof typeof TimelineEventType];

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

// Build a JsonValue object from a loose record, dropping undefined values (JSON has no undefined).
// Trusts callers to pass json-safe leaves (strings/numbers/booleans/nested json).
export function jsonDetails(obj: Record<string, unknown>): JsonValue {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        out[k] = v as JsonValue;
    }
    return out;
}

export interface TimelineEventModuleRef {
    name: string;
    base?: string;
    offset?: string;
}

export interface TimelineEvent {
    schemaVersion: typeof CURRENT_EVENT_SCHEMA_VERSION;
    id: string;
    // Monotonic within a session — total order even when two events share a millisecond timestamp.
    sequence: number;
    type: string;
    source: TimelineEventSource;
    timestamp: string; // ISO-8601 wall clock
    monotonicMs?: number; // performance.now()-style monotonic clock, for ordering/correlation
    targetGeneration?: number;
    processId?: number;
    threadId?: number;
    module?: TimelineEventModuleRef;
    address?: string;
    size?: number;
    severity: TimelineEventSeverity;
    summary: string;
    tags: string[];
    relatedEventIds: string[];
    confidence: TimelineEventConfidence;
    provenance: string; // producer identity, e.g. "producer:relay"
    details?: JsonValue;
}

// What a producer supplies. The store fills in id, sequence, schemaVersion, timestamp/monotonic,
// targetGeneration (from the current generation), and defaults tags/relatedEventIds/confidence.
export interface TimelineEventInput {
    type: string;
    source: TimelineEventSource;
    severity: TimelineEventSeverity;
    summary: string;
    timestamp?: string;
    monotonicMs?: number;
    targetGeneration?: number;
    processId?: number;
    threadId?: number;
    module?: TimelineEventModuleRef;
    address?: string;
    size?: number;
    tags?: string[];
    relatedEventIds?: string[];
    confidence?: TimelineEventConfidence;
    provenance?: string;
    details?: JsonValue;
}

// --- Import validation ------------------------------------------------------

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(jsonValueSchema),
        z.record(z.string(), jsonValueSchema),
    ]),
);

export const timelineEventSchema = z.object({
    schemaVersion: z.literal(CURRENT_EVENT_SCHEMA_VERSION),
    id: z.string(),
    sequence: z.number(),
    type: z.string(),
    source: z.enum([
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
        "decompiler",
        "user",
    ]),
    timestamp: z.string(),
    monotonicMs: z.number().optional(),
    targetGeneration: z.number().optional(),
    processId: z.number().optional(),
    threadId: z.number().optional(),
    module: z
        .object({ name: z.string(), base: z.string().optional(), offset: z.string().optional() })
        .optional(),
    address: z.string().optional(),
    size: z.number().optional(),
    severity: z.enum(["debug", "info", "notice", "warning", "error"]),
    summary: z.string(),
    tags: z.array(z.string()),
    relatedEventIds: z.array(z.string()),
    confidence: z.enum(["exact", "derived", "heuristic"]),
    provenance: z.string(),
    details: jsonValueSchema.optional(),
});

// The export envelope. `schemaVersion` gates import; a mismatch is rejected cleanly (no partial import).
export const timelineExportSchema = z.object({
    schemaVersion: z.literal(CURRENT_EVENT_SCHEMA_VERSION),
    exportedAt: z.string(),
    events: z.array(timelineEventSchema),
});

export type TimelineExport = z.infer<typeof timelineExportSchema>;

export const SEVERITY_ORDER: Record<TimelineEventSeverity, number> = {
    debug: 0,
    info: 1,
    notice: 2,
    warning: 3,
    error: 4,
};
