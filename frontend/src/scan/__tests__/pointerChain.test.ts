import { describe, expect, it } from "vitest";
import { buildPointerIndex, findPointerChains, resolveChain, slotsWithValueInRange, type ModuleRange, type PointerSlot } from "../pointerChain";

const MODULES: ModuleRange[] = [{ name: "game.exe", base: 0x1000n, size: 0x1000n }]; // [0x1000, 0x2000)

// A synthetic pointer map encoding two chains to target 0x5000:
//   game.exe+0x100 -> [0x1100]=0x4ff0 (+0x10) = 0x5000                      (depth 1)
//   game.exe+0x200 -> [0x1200]=0x7ff0 (+0x10)=0x8000 -> [0x8000]=0x4ff8 (+0x8)=0x5000  (depth 2)
const MAP: PointerSlot[] = [
    { slot: 0x1100n, value: 0x4ff0n },
    { slot: 0x8000n, value: 0x4ff8n },
    { slot: 0x1200n, value: 0x7ff0n },
    { slot: 0x9999n, value: 0x0n }, // noise
];

describe("pointer index range query", () => {
    it("finds slots whose value is within a range", () => {
        const idx = buildPointerIndex(MAP);
        const hits = slotsWithValueInRange(idx, 0x4fc0n, 0x5000n, 100);
        expect(hits.map((h) => h.slot).sort()).toEqual([0x1100n, 0x8000n].sort());
    });
    it("respects the result cap", () => {
        const idx = buildPointerIndex(MAP);
        expect(slotsWithValueInRange(idx, 0x0n, 0xffffn, 1).length).toBe(1);
    });
});

describe("findPointerChains", () => {
    it("discovers a depth-1 static chain", () => {
        const idx = buildPointerIndex(MAP);
        const chains = findPointerChains(idx, { target: 0x5000n, maxDepth: 1, maxOffset: 0x40n, maxResults: 50, modules: MODULES, staticOnly: true });
        const c = chains.find((x) => x.depth === 1);
        expect(c).toBeTruthy();
        expect(c!.baseModule).toBe("game.exe");
        expect(c!.baseRva).toBe("0x100");
        expect(c!.offsets).toEqual(["0x10"]);
    });

    it("discovers a depth-2 static chain", () => {
        const idx = buildPointerIndex(MAP);
        const chains = findPointerChains(idx, { target: 0x5000n, maxDepth: 3, maxOffset: 0x40n, maxResults: 50, modules: MODULES, staticOnly: true });
        const c = chains.find((x) => x.depth === 2);
        expect(c).toBeTruthy();
        expect(c!.baseModule).toBe("game.exe");
        expect(c!.baseRva).toBe("0x200");
        expect(c!.offsets).toEqual(["0x10", "0x8"]);
    });

    it("caps the number of chains returned", () => {
        const idx = buildPointerIndex(MAP);
        const chains = findPointerChains(idx, { target: 0x5000n, maxDepth: 3, maxOffset: 0x40n, maxResults: 1, modules: MODULES, staticOnly: true });
        expect(chains.length).toBeLessThanOrEqual(1);
    });
});

describe("resolveChain", () => {
    it("forward-resolves a discovered chain back to the target", () => {
        const read = (addr: bigint): bigint | undefined => MAP.find((m) => m.slot === addr)?.value;
        expect(resolveChain("0x1100", ["0x10"], read)).toBe(0x5000n);
        expect(resolveChain("0x1200", ["0x10", "0x8"], read)).toBe(0x5000n);
    });
    it("returns undefined on an unreadable hop", () => {
        expect(resolveChain("0xdead", ["0x0"], () => undefined)).toBeUndefined();
    });
});
