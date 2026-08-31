import { describe, expect, it } from "vitest";
import { planReadBatches, type WatchRead } from "../readplan";

describe("planReadBatches", () => {
    it("deduplicates identical address+size reads, merging watch ids", () => {
        const reads: WatchRead[] = [
            { watchId: "a", address: "0x1000", size: 4 },
            { watchId: "b", address: "0x1000", size: 4 },
            { watchId: "c", address: "0x2000", size: 8 },
        ];
        const { batches } = planReadBatches(reads);
        const entries = batches.flatMap((b) => b.entries);
        expect(entries.length).toBe(2);
        const e = entries.find((x) => x.address === "0x1000")!;
        expect(e.watchIds.sort()).toEqual(["a", "b"]);
    });

    it("splits into bounded batches by entry count and byte budget", () => {
        const reads: WatchRead[] = Array.from({ length: 10 }, (_, i) => ({ watchId: `w${i}`, address: `0x${(0x1000 + i * 0x100).toString(16)}`, size: 64 }));
        const { batches } = planReadBatches(reads, { maxEntriesPerBatch: 3, maxBytesPerBatch: 1024, maxBytesPerEntry: 0x10000 });
        expect(batches.every((b) => b.entries.length <= 3)).toBe(true);
        expect(batches.flatMap((b) => b.entries).length).toBe(10);
    });

    it("routes oversize reads to the oversize list instead of a batch", () => {
        const { batches, oversize } = planReadBatches(
            [{ watchId: "big", address: "0x1000", size: 0x20000 }],
            { maxEntriesPerBatch: 8, maxBytesPerBatch: 0x40000, maxBytesPerEntry: 0x10000 },
        );
        expect(batches.length).toBe(0);
        expect(oversize.map((r) => r.watchId)).toEqual(["big"]);
    });

    it("drops zero/negative sizes", () => {
        const { batches } = planReadBatches([{ watchId: "z", address: "0x1", size: 0 }]);
        expect(batches.length).toBe(0);
    });
});
