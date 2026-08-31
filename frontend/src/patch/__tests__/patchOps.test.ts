import { describe, expect, it } from "vitest";
import { byteDiff, conflictingIds, findConflicts, hexLen, nopFill, normalizeHex, type Range } from "../patchOps";

describe("patch byte ops", () => {
    it("normalizes hex, rejecting odd/invalid input", () => {
        expect(normalizeHex("90 90 90")).toBe("909090");
        expect(normalizeHex("0xDEadBE ef")).toBe("deadbeef");
        expect(normalizeHex("909")).toBeUndefined(); // odd
        expect(normalizeHex("zz")).toBeUndefined();
        expect(normalizeHex("")).toBeUndefined();
    });
    it("nop-fills a length", () => {
        expect(nopFill(3)).toBe("909090");
        expect(nopFill(0)).toBe("");
        expect(hexLen(nopFill(4))).toBe(4);
    });
    it("diffs bytes", () => {
        const d = byteDiff("aabbcc", "aa00cc");
        expect(d).toEqual([{ offset: 1, before: "bb", after: "00" }]);
    });
});

describe("conflict detection", () => {
    it("finds overlapping ranges", () => {
        const ranges: Range[] = [
            { id: "a", start: 0x1000n, length: 4 }, // [0x1000, 0x1004)
            { id: "b", start: 0x1002n, length: 4 }, // overlaps a
            { id: "c", start: 0x2000n, length: 8 }, // separate
        ];
        expect(findConflicts(ranges)).toEqual([["a", "b"]]);
        expect([...conflictingIds(ranges)].sort()).toEqual(["a", "b"]);
    });
    it("reports no conflict for adjacent, non-overlapping ranges", () => {
        const ranges: Range[] = [
            { id: "a", start: 0x1000n, length: 4 }, // [0x1000, 0x1004)
            { id: "b", start: 0x1004n, length: 4 }, // starts exactly at a's end
        ];
        expect(findConflicts(ranges)).toEqual([]);
    });
});
