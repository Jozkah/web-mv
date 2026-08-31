import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createTraceStore, filterTrace } from "../traceStore";
import type { EmulatedTraceEntry } from "../model";

const entry = (over: Partial<EmulatedTraceEntry> = {}): EmulatedTraceEntry => ({
    index: over.index ?? 0,
    runId: over.runId ?? 1,
    address: over.address ?? "0x1000",
    size: over.size ?? 4,
    bytes: over.bytes ?? "90",
    ...over,
});

describe("filterTrace", () => {
    it("filters by run and text (address/bytes)", () => {
        const es = [
            entry({ index: 0, runId: 1, address: "0x1000", bytes: "4883ec28" }),
            entry({ index: 1, runId: 2, address: "0x2000", bytes: "c3" }),
        ];
        expect(filterTrace(es, { runId: 2 }).map((e) => e.index)).toEqual([1]);
        expect(filterTrace(es, { text: "1000" }).map((e) => e.index)).toEqual([0]);
        expect(filterTrace(es, { text: "c3" }).map((e) => e.index)).toEqual([1]);
    });
});

describe("createTraceStore", () => {
    it("ingests runs in batches and records summaries", () => {
        createRoot((dispose) => {
            const t = createTraceStore();
            t.ingestRun([entry({ index: 0 }), entry({ index: 1 })], {
                runId: 1, sessionId: "s", targetGeneration: 1, entryRip: "0x1000", finalRip: "0x1008",
                instructionCount: 2, stopReason: "stop_reached", traceCount: 2, traceDropped: 0, registerDeltas: {}, at: "t",
            });
            expect(t.count()).toBe(2);
            expect(t.runs().length).toBe(1);
            dispose();
        });
    });

    it("exports and re-imports as read-only, rejecting a bad schema", () => {
        createRoot((dispose) => {
            const t = createTraceStore();
            t.ingestRun([entry({ index: 0, address: "0x1000" })]);
            const json = t.exportJSON({ provenance: "Angel Unicorn emulation" });
            const n = t.importJSON(json);
            expect(n).toBe(1);
            expect(t.imported()).toBe(true);
            expect(() => t.importJSON("{not json")).toThrow();
            expect(() => t.importJSON(JSON.stringify({ format: "wrong", schemaVersion: 1, entries: [] }))).toThrow();
            dispose();
        });
    });
});
