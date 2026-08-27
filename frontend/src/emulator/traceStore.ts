import { createMemo, createSignal } from "solid-js";
import { z } from "zod";
import { EMU_TRACE_LIMIT_MAX, type EmulatedTraceEntry, type EmulatorRunSummary } from "./model";

// Bounded emulated-instruction trace store. Fed in batches per run (never one reactive update per
// instruction), filterable, and virtualization-friendly. Plain array + version signal, same pattern
// as the timeline store, to keep high-volume ingestion cheap.

const HARD_MAX = EMU_TRACE_LIMIT_MAX; // absolute ceiling regardless of per-run limits
const COMPACT_SLACK = 4096;

export interface TraceFilter {
    text?: string; // matches address / bytes
    runId?: number; // restrict to one run
}

export function traceMatches(e: EmulatedTraceEntry, f: TraceFilter): boolean {
    if (f.runId !== undefined && e.runId !== f.runId) return false;
    const q = f.text?.trim().toLowerCase();
    if (q) {
        const hay = `${e.address} ${e.bytes ?? ""} ${e.disassembly ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
    }
    return true;
}

export function filterTrace(entries: readonly EmulatedTraceEntry[], f: TraceFilter): EmulatedTraceEntry[] {
    return entries.filter((e) => traceMatches(e, f));
}

// --- export/import schema ---
const EXPORT_FORMAT = "web-mv.emulator-trace";
const traceEntrySchema = z.object({
    index: z.number().int(),
    runId: z.number().int(),
    address: z.string(),
    size: z.number().int().optional(),
    bytes: z.string().optional(),
    disassembly: z.string().optional(),
});
export const traceExportSchema = z.object({
    format: z.literal(EXPORT_FORMAT),
    schemaVersion: z.literal(1),
    appVersion: z.string().optional(),
    session: z.record(z.string(), z.unknown()).optional(),
    targetFingerprint: z.string().optional(),
    initialRegisters: z.record(z.string(), z.string()).optional(),
    finalRegisters: z.record(z.string(), z.string()).optional(),
    entryAddress: z.string().optional(),
    stopAddress: z.string().optional(),
    stopReason: z.string().optional(),
    runs: z.array(z.record(z.string(), z.unknown())).optional(),
    entries: z.array(traceEntrySchema),
    truncated: z.number().int().optional(),
    provenance: z.string().optional(),
});
export type TraceExport = z.infer<typeof traceExportSchema>;

export function createTraceStore() {
    let buffer: EmulatedTraceEntry[] = [];
    let head = 0;
    const [version, setVersion] = createSignal(0);
    const [dropped, setDropped] = createSignal(0);
    const [runs, setRuns] = createSignal<EmulatorRunSummary[]>([]);
    const [filter, setFilter] = createSignal<TraceFilter>({});
    const [imported, setImported] = createSignal(false);

    const touch = () => setVersion((v) => v + 1);
    const slice = () => (head === 0 ? buffer : buffer.slice(head));
    const live = () => {
        version();
        return slice();
    };

    function push(e: EmulatedTraceEntry): void {
        buffer.push(e);
        if (buffer.length - head > HARD_MAX) {
            head += 1;
            setDropped((d) => d + 1);
        }
        if (head > COMPACT_SLACK) {
            buffer = buffer.slice(head);
            head = 0;
        }
    }

    // Ingest one run's trace as a single batch → one reactive update, never one per instruction.
    function ingestRun(entries: readonly EmulatedTraceEntry[], summary?: EmulatorRunSummary): void {
        for (const e of entries) push(e);
        if (summary) setRuns((r) => [...r, summary]);
        touch();
    }

    const filtered = createMemo(() => filterTrace(live(), filter()));

    function clear(): void {
        buffer = [];
        head = 0;
        setRuns([]);
        setDropped(0);
        setImported(false);
        touch();
    }

    function exportJSON(meta: Omit<TraceExport, "format" | "schemaVersion" | "entries" | "runs">): string {
        const payload: TraceExport = {
            format: EXPORT_FORMAT,
            schemaVersion: 1,
            entries: slice(),
            runs: runs() as unknown as TraceExport["runs"],
            ...meta,
        };
        return JSON.stringify(payload, null, 2);
    }

    // Import a previously exported trace as READ-ONLY evidence (marked imported). It can never call
    // the agent or modify the target. A newer/unknown schema is rejected cleanly.
    function importJSON(text: string): number {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error("emulator trace import: not valid JSON");
        }
        const res = traceExportSchema.safeParse(parsed);
        if (!res.success) throw new Error(`emulator trace import: schema mismatch (${res.error.issues[0]?.message ?? "invalid"})`);
        clear();
        for (const e of res.data.entries) push({ ...e, disassembly: e.disassembly, bytes: e.bytes });
        setImported(true);
        touch();
        return res.data.entries.length;
    }

    return {
        entries: live,
        filtered,
        runs,
        dropped,
        count: () => {
            version();
            return buffer.length - head;
        },
        filter,
        setFilter,
        ingestRun,
        clear,
        exportJSON,
        importJSON,
        imported,
    };
}

export type TraceStore = ReturnType<typeof createTraceStore>;
