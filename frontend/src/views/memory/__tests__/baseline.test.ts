import { describe, expect, it } from "vitest";
import { baselineValid, baselineView, captureBaseline, changedFromBaseline } from "../nodes/baseline";

const viewOf = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe("captureBaseline", () => {
    it("freezes a copy of the snapshot bytes", () => {
        const src = new Uint8Array([1, 2, 3, 4]);
        const b = captureBaseline("k", new DataView(src.buffer));
        src[0] = 99; // later poll mutating the source must not touch the baseline
        expect([...b.bytes]).toEqual([1, 2, 3, 4]);
        expect(b.key).toBe("k");
    });
});

describe("baselineValid", () => {
    it("matches only the exact region key", () => {
        const b = captureBaseline("c1@0x1000:16", viewOf(0));
        expect(baselineValid(b, "c1@0x1000:16")).toBe(true);
        expect(baselineValid(b, "c1@0x2000:16")).toBe(false); // address changed
        expect(baselineValid(b, "c1@0x1000:32")).toBe(false); // layout size changed
        expect(baselineValid(b, "c2@0x1000:16")).toBe(false); // class changed
        expect(baselineValid(b, "")).toBe(false);
        expect(baselineValid(undefined, "c1@0x1000:16")).toBe(false);
    });
});

describe("changedFromBaseline", () => {
    const base = captureBaseline("k", viewOf(0x10, 0x20, 0x30, 0x40));

    it("detects any differing byte in the field span", () => {
        expect(changedFromBaseline(viewOf(0x10, 0x20, 0x30, 0x40), base, 0, 4)).toBe(false);
        expect(changedFromBaseline(viewOf(0x10, 0x21, 0x30, 0x40), base, 0, 4)).toBe(true);
        expect(changedFromBaseline(viewOf(0x10, 0x21, 0x30, 0x40), base, 2, 2)).toBe(false);
        expect(changedFromBaseline(viewOf(0x10, 0x20, 0x30, 0x41), base, 3, 1)).toBe(true);
    });

    it("treats out-of-bounds spans as unchanged on either side", () => {
        expect(changedFromBaseline(viewOf(0x10, 0x20), base, 0, 4)).toBe(false); // view too short
        expect(changedFromBaseline(viewOf(0, 0, 0, 0, 0, 0xff), base, 4, 2)).toBe(false); // past baseline
    });
});

describe("baselineView", () => {
    it("exposes the frozen bytes for decoding 'was' values", () => {
        const b = captureBaseline("k", viewOf(0x2a, 0x00, 0x00, 0x00));
        expect(baselineView(b).getInt32(0, true)).toBe(42);
    });
});
