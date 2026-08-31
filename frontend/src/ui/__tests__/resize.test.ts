import { describe, expect, it } from "vitest";
import { clampWidth, keyboardResize } from "../resize";

describe("clampWidth", () => {
    it("clamps to [min, max] and rounds", () => {
        expect(clampWidth(300.6, 240, 720)).toBe(301);
        expect(clampWidth(100, 240, 720)).toBe(240);
        expect(clampWidth(9999, 240, 720)).toBe(720);
        expect(clampWidth(NaN, 240, 720)).toBe(240);
    });
});

describe("keyboardResize", () => {
    it("nudges left/right within bounds, larger with Shift", () => {
        expect(keyboardResize(300, "ArrowRight", 240, 720)).toBe(316);
        expect(keyboardResize(300, "ArrowLeft", 240, 720)).toBe(284);
        expect(keyboardResize(300, "Shift+ArrowRight", 240, 720)).toBe(364);
        expect(keyboardResize(250, "ArrowLeft", 240, 720)).toBe(240); // clamped at min
        expect(keyboardResize(300, "ArrowUp", 240, 720)).toBeUndefined();
    });
});
