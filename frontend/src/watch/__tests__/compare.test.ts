import { describe, expect, it } from "vitest";
import { bytesChanged, computeDelta, evaluatePredicate, type CompareContext } from "../compare";
import { decodeWatchValue } from "../decode";
import type { WatchPredicate, WatchValueType } from "../model";

function v(hex: string, valueType: WatchValueType = "int32") {
    return decodeWatchValue(hex, { valueType, endianness: "little", displayBase: "auto" });
}
// little-endian int32 hex for a value
function i32(n: number): string {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n, true);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function f32(n: number): string {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, n, true);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const ctx = (cur: string, prev?: string, base?: string, valueType: WatchValueType = "int32"): CompareContext => ({
    valueType,
    current: v(cur, valueType),
    previous: prev ? v(prev, valueType) : undefined,
    baseline: base ? v(base, valueType) : undefined,
});
const p = (over: Partial<WatchPredicate>): WatchPredicate => ({ mode: "changed", basis: "previous", ...over });

describe("bytesChanged / computeDelta", () => {
    it("detects raw byte change only on two successful reads", () => {
        expect(bytesChanged(v(i32(1)), v(i32(2)))).toBe(true);
        expect(bytesChanged(v(i32(1)), v(i32(1)))).toBe(false);
        expect(bytesChanged(undefined, v(i32(1)))).toBe(false);
    });
    it("computes signed delta", () => {
        expect(computeDelta(v(i32(10)), v(i32(3)))).toBe("+7");
        expect(computeDelta(v(i32(3)), v(i32(10)))).toBe("-7");
    });
});

describe("evaluatePredicate — numeric vs previous", () => {
    it("changed / unchanged / increased / decreased", () => {
        expect(evaluatePredicate(p({ mode: "changed" }), ctx(i32(2), i32(1)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "unchanged" }), ctx(i32(1), i32(1)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "increased" }), ctx(i32(2), i32(1)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "decreased" }), ctx(i32(1), i32(2)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "increased" }), ctx(i32(1), i32(2)))).toBe(false);
    });
    it("increasedBy / decreasedBy with amount", () => {
        expect(evaluatePredicate(p({ mode: "increasedBy", operand: "5" }), ctx(i32(10), i32(5)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "increasedBy", operand: "4" }), ctx(i32(10), i32(5)))).toBe(false);
        expect(evaluatePredicate(p({ mode: "decreasedBy", operand: "3" }), ctx(i32(2), i32(5)))).toBe(true);
    });
    it("has no previous → does not fire", () => {
        expect(evaluatePredicate(p({ mode: "changed" }), ctx(i32(2)))).toBe(false);
    });
});

describe("evaluatePredicate — constant basis", () => {
    it("equal / notEqual / greater / less / range", () => {
        expect(evaluatePredicate(p({ mode: "equal", basis: "constant", operand: "100" }), ctx(i32(100)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "notEqual", basis: "constant", operand: "100" }), ctx(i32(99)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "greater", basis: "constant", operand: "50" }), ctx(i32(51)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "less", basis: "constant", operand: "50" }), ctx(i32(49)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "range", basis: "constant", operand: "10", operandHigh: "20" }), ctx(i32(15)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "range", basis: "constant", operand: "10", operandHigh: "20" }), ctx(i32(25)))).toBe(false);
    });
});

describe("evaluatePredicate — threshold crossing (needs previous)", () => {
    it("crossedUp / crossedDown", () => {
        expect(evaluatePredicate(p({ mode: "crossedUp", operand: "100" }), ctx(i32(120), i32(80)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "crossedUp", operand: "100" }), ctx(i32(90), i32(80)))).toBe(false);
        expect(evaluatePredicate(p({ mode: "crossedDown", operand: "100" }), ctx(i32(80), i32(120)))).toBe(true);
    });
});

describe("evaluatePredicate — floats and NaN", () => {
    it("epsilon equality", () => {
        expect(evaluatePredicate(p({ mode: "equal", basis: "constant", operand: "1.5", epsilon: 0.01 }), ctx(f32(1.504), undefined, undefined, "float32"))).toBe(true);
        expect(evaluatePredicate(p({ mode: "equal", basis: "constant", operand: "1.5", epsilon: 0.001 }), ctx(f32(1.504), undefined, undefined, "float32"))).toBe(false);
    });
    it("NaN never compares as a normal number", () => {
        expect(evaluatePredicate(p({ mode: "greater", basis: "constant", operand: "0" }), ctx(f32(NaN), undefined, undefined, "float32"))).toBe(false);
        expect(evaluatePredicate(p({ mode: "equal", basis: "constant", operand: "0" }), ctx(f32(NaN), undefined, undefined, "float32"))).toBe(false);
    });
});

describe("evaluatePredicate — bits, pointer, string", () => {
    it("bit set / cleared / changed", () => {
        expect(evaluatePredicate(p({ mode: "bitSet", bitIndex: 2 }), ctx(i32(0b100)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "bitCleared", bitIndex: 1 }), ctx(i32(0b100)))).toBe(true);
        expect(evaluatePredicate(p({ mode: "bitChanged", bitIndex: 0 }), ctx(i32(1), i32(0)))).toBe(true);
    });
    it("string contains / changed", () => {
        const cur = decodeWatchValue("48656c6c6f00", { valueType: "ascii", endianness: "little", byteLength: 6, displayBase: "auto" }); // "Hello"
        expect(evaluatePredicate(p({ mode: "stringContains", operand: "ell" }), { valueType: "ascii", current: cur })).toBe(true);
        expect(evaluatePredicate(p({ mode: "stringContains", operand: "xyz" }), { valueType: "ascii", current: cur })).toBe(false);
    });
});
