import { describe, expect, it } from "vitest";
import { createWatchHistory, type WatchSample } from "../history";

const sample = (over: Partial<WatchSample> = {}): Omit<WatchSample, "seq"> => ({
    timestamp: "2026-01-01T00:00:00.000Z",
    monotonicMs: 0,
    generation: 1,
    address: "0x1000",
    bytesHex: "00000000",
    display: "0",
    changed: false,
    ...over,
});

describe("createWatchHistory", () => {
    it("bounds each watch to its history limit and counts drops", () => {
        const h = createWatchHistory();
        for (let i = 0; i < 300; i++) h.push("w1", sample({ display: String(i) }), 256);
        expect(h.count("w1")).toBe(256);
        expect(h.droppedFor("w1")).toBe(44);
        // oldest surviving is sample #44
        expect(h.get("w1")[0].display).toBe("44");
    });

    it("enforces a global byte budget across watches", () => {
        // 8 bytes/sample; budget 80 bytes → at most 10 samples total across all lanes.
        const h = createWatchHistory(80);
        for (let i = 0; i < 8; i++) h.push("a", sample({ bytesHex: "1122334455667788" }), 1000);
        for (let i = 0; i < 8; i++) h.push("b", sample({ bytesHex: "1122334455667788" }), 1000);
        expect(h.count("a") + h.count("b")).toBeLessThanOrEqual(10);
        expect(h.bytes()).toBeLessThanOrEqual(80);
        expect(h.totalDropped()).toBeGreaterThan(0);
    });

    it("segments a watch's history by target generation", () => {
        const h = createWatchHistory();
        h.push("w", sample({ generation: 1, display: "a" }), 100);
        h.push("w", sample({ generation: 1, display: "b" }), 100);
        h.push("w", sample({ generation: 2, display: "c" }), 100);
        const segs = h.segments("w");
        expect(segs.length).toBe(2);
        expect(segs[0].map((s) => s.display)).toEqual(["a", "b"]);
        expect(segs[1].map((s) => s.display)).toEqual(["c"]);
    });

    it("clears per watch and globally", () => {
        const h = createWatchHistory();
        h.push("w", sample(), 100);
        h.clear("w");
        expect(h.count("w")).toBe(0);
        h.push("w", sample(), 100);
        h.clearAll();
        expect(h.count("w")).toBe(0);
        expect(h.bytes()).toBe(0);
    });
});
