import { describe, expect, it } from "vitest";
import { createEffect, createRoot } from "solid-js";
import { createTimelineStore } from "../timeline/timelineStore";
import { filterEvents, groupEvents } from "../timeline/timelineStore";
import type { TimelineEventInput } from "../timeline/events";
import { deriveConversations, deriveEndpoints, parsePacketSummaries, SUMMARY_COLUMNS, parseFollowStream } from "../network/pcapParse";
import { mapAnalysis, type GhidraAnalysis } from "../decompiler/ghidraParse";
import { serializeCsv, num, raw, text } from "../ui/csv";

// Reproducible micro-benchmarks for the major workloads. These are STRUCTURAL tests first (counts,
// single-recompute, bounded output) — wall-clock is measured, printed for human review, and only
// loosely asserted against generous ceilings so CI noise never fails the build. Fixtures are synthetic
// and deterministic. Run: `npx vitest run src/__benchmarks__/perf.test.ts`.

function bench(name: string, fn: () => void, { warmup = 3, samples = 7 } = {}): { median: number; p90: number } {
    for (let i = 0; i < warmup; i++) fn();
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
        const t0 = performance.now();
        fn();
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    const p90 = times[Math.min(times.length - 1, Math.floor(times.length * 0.9))]!;
    // eslint-disable-next-line no-console
    console.log(`[bench] ${name}: median ${median.toFixed(2)}ms p90 ${p90.toFixed(2)}ms (n=${samples})`);
    return { median, p90 };
}

const COL = SUMMARY_COLUMNS;
function pcapFixture(rows: number): string {
    const out: string[] = [COL.join("\t")];
    for (let i = 1; i <= rows; i++) {
        const r: Partial<Record<(typeof COL)[number], string>> = {
            "frame.number": String(i),
            "frame.time_epoch": String(1000 + i * 0.001),
            "frame.len": String(60 + (i % 200)),
            "ip.src": `10.0.${(i >> 8) & 255}.${i & 255}`,
            "ip.dst": `10.1.${(i >> 8) & 255}.${i & 255}`,
            "_ws.col.Protocol": i % 3 === 0 ? "UDP" : "TCP",
            "tcp.stream": i % 3 === 0 ? "" : String(i % 500),
            "udp.stream": i % 3 === 0 ? String(i % 500) : "",
            "_ws.col.Info": `packet ${i}`,
        };
        out.push(COL.map((c) => r[c] ?? "").join("\t"));
    }
    return out.join("\n");
}

function ghidraFixture(n: number): GhidraAnalysis {
    const functions = Array.from({ length: n }, (_, i) => ({ address: `0x${(0x140001000 + i * 16).toString(16)}`, name: `sub_${i}`, signature: `void sub_${i}(void)`, callingConvention: "__fastcall", size: 16 }));
    return { format: "web-mv.ghidra.analysis", schemaVersion: 1, imageBase: "0x140000000", functions, symbols: [], warnings: [], truncated: false };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("perf — timeline", () => {
    it("ingests 10,000 events in one batch with exactly one reactive recompute", async () => {
        await createRoot(async (dispose) => {
            const tl = createTimelineStore();
            const inputs: TimelineEventInput[] = Array.from({ length: 10000 }, (_, i) => ({ type: "memory.watch.changed", source: "memory", severity: "info", summary: `s${i}` }));
            let recomputes = 0;
            createEffect(() => { void tl.events; recomputes++; });
            await tick();
            expect(recomputes).toBe(1); // initial run
            bench("timeline.ingestMany(10k)", () => { createTimelineStore().ingestMany(inputs); });
            tl.ingestMany(inputs);
            await tick();
            expect(recomputes).toBe(2); // exactly one more for the whole batch (never N)
            expect(tl.events.length).toBeLessThanOrEqual(10000); // bounded retention
            dispose();
        });
    });

    it("filters and groups 10,000 events within bounded work", () => {
        const tl = createTimelineStore();
        tl.ingestMany(Array.from({ length: 10000 }, (_, i) => ({ type: i % 2 ? "a.b" : "c.d", source: (i % 2 ? "memory" : "network") as TimelineEventInput["source"], severity: "info", summary: `find-${i}` })));
        const events = tl.events;
        bench("timeline.filter(text)", () => { filterEvents(events, { text: "find-42" }, 0); });
        bench("timeline.group(source)", () => { groupEvents(events, "source"); });
        expect(groupEvents(events, "source").length).toBeGreaterThan(0);
    });
});

describe("perf — network pcap", () => {
    const stdout = pcapFixture(5000);
    it("parses 5,000 packet summaries and derives endpoints/conversations", () => {
        let parsed = 0;
        bench("pcap.parseSummaries(5k)", () => { parsed = parsePacketSummaries(stdout).length; });
        expect(parsed).toBe(5000);
        const pkts = parsePacketSummaries(stdout);
        bench("pcap.deriveEndpoints(5k)", () => { deriveEndpoints(pkts); });
        bench("pcap.deriveConversations(5k)", () => { deriveConversations(pkts); });
        expect(deriveEndpoints(pkts).length).toBeGreaterThan(0);
    });
    it("follow-stream parse is bounded by the byte limit", () => {
        const hexLine = "ab".repeat(1000);
        const out = ["Node 0: a", "Node 1: b", ...Array.from({ length: 5000 }, () => hexLine)].join("\n");
        const s = parseFollowStream(out, 256 * 1024);
        expect(s.truncated).toBe(true);
        expect(s.totalBytes).toBeLessThanOrEqual(256 * 1024);
    });
});

describe("perf — ghidra metadata", () => {
    const analysis = ghidraFixture(5000);
    it("maps 5,000 functions (metadata only, no pseudocode)", () => {
        let mapped = 0;
        bench("ghidra.mapAnalysis(5k)", () => { mapped = mapAnalysis(analysis, "0x7ff600000000", "0x140000000").length; });
        expect(mapped).toBe(5000);
        const out = mapAnalysis(analysis, "0x7ff600000000", "0x140000000");
        expect((out[0] as unknown as Record<string, unknown>).pseudocode).toBeUndefined();
    });
});

describe("perf — csv", () => {
    it("serializes a 5,000-row export deterministically", () => {
        const rows = Array.from({ length: 5000 }, (_, i) => [num(i), raw(`0x${i.toString(16)}`), text(`value ${i}, "q"`)]);
        let out = "";
        bench("csv.serialize(5k)", () => { out = serializeCsv(rows, { header: ["seq", "addr", "value"] }); });
        expect(serializeCsv(rows)).toBe(serializeCsv(rows)); // deterministic
        expect(out.split("\r\n").length).toBe(5001);
    });
});
