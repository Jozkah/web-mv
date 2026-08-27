// Memory Watch — serializable definition + runtime model. A Memory Watch polls a memory address
// through documented Angel reads and reports how its value changes over time. It is NOT a debugger
// watchpoint: polling can detect that memory changed, never which instruction wrote it. Terminology
// and capability gating enforce that honesty elsewhere; this file is the typed data model only.

export const WATCH_SCHEMA_VERSION = 1 as const;

export type WatchValueType =
    | "int8"
    | "uint8"
    | "int16"
    | "uint16"
    | "int32"
    | "uint32"
    | "int64"
    | "uint64"
    | "float32"
    | "float64"
    | "bool"
    | "pointer"
    | "bytes"
    | "ascii"
    | "utf8"
    | "utf16le"
    | "utf16be";

export type WatchEndianness = "little" | "big";
export type WatchDisplayBase = "auto" | "hex" | "decimal" | "binary" | "char";

export type WatchComparisonMode =
    | "changed"
    | "unchanged"
    | "increased"
    | "decreased"
    | "increasedBy"
    | "decreasedBy"
    | "equal"
    | "notEqual"
    | "greater"
    | "less"
    | "greaterEqual"
    | "lessEqual"
    | "range"
    | "crossedUp"
    | "crossedDown"
    | "bitChanged"
    | "bitSet"
    | "bitCleared"
    | "pointerChanged"
    | "bytePatternChanged"
    | "stringChanged"
    | "stringContains"
    | "structureBytesChanged";

// What `current` is compared against for modes that need an operand or a reference sample.
export type WatchComparisonBasis = "previous" | "baseline" | "constant";

export interface WatchPredicate {
    mode: WatchComparisonMode;
    basis: WatchComparisonBasis;
    operand?: string; // constant / range-low / substring / threshold / delta amount (as text)
    operandHigh?: string; // range-high
    bitIndex?: number; // for bit* modes
    epsilon?: number; // float fuzzy tolerance
}

export type WatchTriggerAction = "timelineEvent" | "flag" | "notify" | "pauseWatch" | "pauseAll";

export interface WatchTriggerDefinition {
    enabled: boolean;
    everySample: boolean; // false = fire only on the false→true transition (default)
    cooldownMs: number;
    consecutive: number; // require N consecutive matching samples before firing (>=1)
    oneShot: boolean;
    severity: "debug" | "info" | "notice" | "warning" | "error";
    note?: string;
    tag?: string;
    actions: WatchTriggerAction[];
}

export interface MemoryWatchDefinition {
    schemaVersion: typeof WATCH_SCHEMA_VERSION;
    id: string;
    name: string;
    enabled: boolean;
    expression: string; // entered address expression (kept separate from the resolved address)
    valueType: WatchValueType;
    byteLength?: number; // required for bytes/ascii/utf8/utf16* ; bounded
    endianness: WatchEndianness;
    displayBase: WatchDisplayBase;
    intervalMs: number;
    predicate?: WatchPredicate;
    trigger?: WatchTriggerDefinition;
    historyLimit: number;
    /** Emit a timeline `memory.watch.changed` event when the value changes (rate-limited). Default true. */
    emitChangeEvents?: boolean;
    tags: string[];
    notes?: string;
    /** Fingerprint of the target this watch was created/armed under (workspace key), for load safety. */
    targetKey?: string;
    createdAt: string;
    updatedAt: string;
}

// --- Runtime state (never serialized) ---------------------------------------

export type WatchStatus = "idle" | "resolving" | "reading" | "ready" | "paused" | "error" | "stale";

export type WatchValueKind = "int" | "uint" | "float" | "bool" | "pointer" | "bytes" | "string";

export interface DecodedWatchValue {
    ok: boolean;
    kind: WatchValueKind;
    bytesHex: string; // raw bytes actually read (lowercase hex), preserved alongside the decoded value
    byteLength: number;
    int?: bigint; // canonical for int/uint/pointer (64-bit safe)
    float?: number; // for float32/float64
    bool?: boolean;
    text?: string; // for ascii/utf8/utf16*
    display: string; // formatted per display base
    error?: string; // decode failure (partial read, invalid encoding, unterminated string)
}

export type WatchErrorKind =
    | "invalidExpression"
    | "moduleUnavailable"
    | "pointerResolveFailed"
    | "detached"
    | "coreDisconnected"
    | "capabilityUnavailable"
    | "timeout"
    | "cancelled"
    | "unreadable"
    | "partialRead"
    | "decodeFailure"
    | "oversized"
    | "staleGeneration"
    | "unsupportedType"
    | "schedulerInternal";

export interface WatchError {
    kind: WatchErrorKind;
    message: string;
    at: string; // ISO
}

export interface WatchTriggerRuntime {
    matchedStreak: number;
    wasMeeting: boolean; // for transition-only firing
    lastTriggerMs?: number;
    triggerCount: number;
    firedOnce: boolean; // for one-shot
    flagged: boolean; // visual flag latch
}

export interface MemoryWatchRuntime {
    status: WatchStatus;
    resolvedAddress?: string;
    current?: DecodedWatchValue;
    previous?: DecodedWatchValue;
    baseline?: DecodedWatchValue;
    lastReadAt?: string;
    firstChangedAt?: string;
    lastChangedAt?: string;
    changeCount: number;
    consecutiveErrors: number;
    error?: WatchError;
    generation?: number; // generation the current data belongs to (segmentation)
    effectiveIntervalMs?: number; // set when the scheduler throttles the requested interval
    backoffUntilMs?: number; // monotonic time until which polling backs off
    trigger?: WatchTriggerRuntime;
}

export function freshRuntime(): MemoryWatchRuntime {
    return { status: "idle", changeCount: 0, consecutiveErrors: 0 };
}

// --- Bounds / defaults ------------------------------------------------------

// Poll intervals we offer. The scheduler throttles anything below MIN_INTERVAL_MS; the UI shows the
// effective interval when it does. These are deliberately conservative for a polling transport.
export const ALLOWED_INTERVALS_MS = [100, 250, 500, 1000, 2000, 5000] as const;
export const MIN_INTERVAL_MS = 100;
export const MAX_INTERVAL_MS = 60_000;

export const MIN_HISTORY_LIMIT = 16;
export const MAX_HISTORY_LIMIT = 4096;
export const DEFAULT_HISTORY_LIMIT = 256;

// Reads: an individual Angel read is capped at 0x100000 (1 MiB) and a read_batch entry at 0x10000
// (64 KiB); we stay well under that for a watch slice.
export const MAX_WATCH_BYTES = 0x10000; // 64 KiB per watch slice
export const MAX_NAME_LEN = 120;
export const MAX_NOTES_LEN = 2000;
export const MAX_TAGS = 24;
export const MAX_TAG_LEN = 48;
export const MAX_EXPRESSION_LEN = 256;

export const STRING_TYPES: readonly WatchValueType[] = ["ascii", "utf8", "utf16le", "utf16be"];
export const VARIABLE_LENGTH_TYPES: readonly WatchValueType[] = ["bytes", ...STRING_TYPES];

export function isStringType(t: WatchValueType): boolean {
    return STRING_TYPES.includes(t);
}

// Fixed byte width for scalar types; undefined for variable-length (bytes/strings) which carry an
// explicit byteLength.
export function fixedWidth(t: WatchValueType): number | undefined {
    switch (t) {
        case "int8":
        case "uint8":
        case "bool":
            return 1;
        case "int16":
        case "uint16":
            return 2;
        case "int32":
        case "uint32":
        case "float32":
            return 4;
        case "int64":
        case "uint64":
        case "float64":
        case "pointer":
            return 8;
        default:
            return undefined; // bytes / ascii / utf8 / utf16*
    }
}

// Total bytes a watch reads for its type + optional byteLength.
export function watchReadSize(def: Pick<MemoryWatchDefinition, "valueType" | "byteLength">): number | undefined {
    const w = fixedWidth(def.valueType);
    if (w !== undefined) return w;
    return def.byteLength;
}

// --- Validation -------------------------------------------------------------

export interface ValidationResult {
    ok: boolean;
    errors: string[];
}

export function validateDefinition(def: Partial<MemoryWatchDefinition>): ValidationResult {
    const errors: string[] = [];
    if (!def.name || def.name.trim() === "") errors.push("name is required");
    if (def.name && def.name.length > MAX_NAME_LEN) errors.push(`name exceeds ${MAX_NAME_LEN} chars`);
    if (!def.expression || def.expression.trim() === "") errors.push("address expression is required");
    if (def.expression && def.expression.length > MAX_EXPRESSION_LEN) errors.push("expression too long");
    if (!def.valueType) errors.push("value type is required");

    if (def.intervalMs === undefined || !(def.intervalMs >= MIN_INTERVAL_MS && def.intervalMs <= MAX_INTERVAL_MS)) {
        errors.push(`interval must be ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS} ms`);
    }
    if (
        def.historyLimit === undefined ||
        !(def.historyLimit >= MIN_HISTORY_LIMIT && def.historyLimit <= MAX_HISTORY_LIMIT)
    ) {
        errors.push(`history limit must be ${MIN_HISTORY_LIMIT}..${MAX_HISTORY_LIMIT}`);
    }

    if (def.valueType && VARIABLE_LENGTH_TYPES.includes(def.valueType)) {
        const len = def.byteLength;
        if (len === undefined || len <= 0) errors.push("byte length is required for bytes/string types");
        else if (len > MAX_WATCH_BYTES) errors.push(`byte length exceeds ${MAX_WATCH_BYTES}`);
    }

    if (def.notes && def.notes.length > MAX_NOTES_LEN) errors.push(`notes exceed ${MAX_NOTES_LEN} chars`);
    if (def.tags) {
        if (def.tags.length > MAX_TAGS) errors.push(`too many tags (max ${MAX_TAGS})`);
        if (def.tags.some((t) => t.length > MAX_TAG_LEN)) errors.push(`a tag exceeds ${MAX_TAG_LEN} chars`);
    }
    return { ok: errors.length === 0, errors };
}

let idSeq = 0;
export function nextWatchId(): string {
    idSeq++;
    return `watch_${Date.now().toString(36)}_${idSeq}`;
}

export interface CreateWatchInput {
    name?: string;
    expression: string;
    valueType?: WatchValueType;
    byteLength?: number;
    endianness?: WatchEndianness;
    displayBase?: WatchDisplayBase;
    intervalMs?: number;
    predicate?: WatchPredicate;
    trigger?: WatchTriggerDefinition;
    historyLimit?: number;
    tags?: string[];
    notes?: string;
    targetKey?: string;
    nowIso?: string;
}

export function createWatch(input: CreateWatchInput): MemoryWatchDefinition {
    const now = input.nowIso ?? new Date().toISOString();
    const valueType = input.valueType ?? "int32";
    return {
        schemaVersion: WATCH_SCHEMA_VERSION,
        id: nextWatchId(),
        name: input.name?.trim() || input.expression.trim(),
        enabled: true,
        expression: input.expression.trim(),
        valueType,
        byteLength: VARIABLE_LENGTH_TYPES.includes(valueType) ? (input.byteLength ?? 16) : input.byteLength,
        endianness: input.endianness ?? "little",
        displayBase: input.displayBase ?? "auto",
        intervalMs: input.intervalMs ?? 500,
        predicate: input.predicate,
        trigger: input.trigger,
        historyLimit: input.historyLimit ?? DEFAULT_HISTORY_LIMIT,
        emitChangeEvents: true,
        tags: input.tags ?? [],
        notes: input.notes,
        targetKey: input.targetKey,
        createdAt: now,
        updatedAt: now,
    };
}

// Forward-compatible migration hook. v1 is current; unknown/newer versions are rejected by the
// importer, older versions would be upgraded here.
export function migrateDefinition(raw: unknown): MemoryWatchDefinition | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    if (r.schemaVersion !== WATCH_SCHEMA_VERSION) return undefined;
    const v = validateDefinition(r as Partial<MemoryWatchDefinition>);
    if (!v.ok) return undefined;
    return r as unknown as MemoryWatchDefinition;
}
