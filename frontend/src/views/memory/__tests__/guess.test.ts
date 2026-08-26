import { describe, expect, it } from "vitest";
import {
    finalizeSuggestion,
    isUsermodePointer,
    meetsThreshold,
    planGuesses,
    planSuggestions,
    sameFields,
} from "../nodes/guess";
import { createNode, padding } from "../nodes/layout";
import type { Node } from "../nodes/types";

// The confidence-graded guesser: classification rules are the original ones; the tests here pin
// the confidence tiers, the reasons, lock handling, and the pointer finalize path.

const viewOf = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

const f32 = (value: number): number[] => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, value, true);
    return [...b];
};

describe("planSuggestions confidence tiers", () => {
    it("terminated ASCII runs are high confidence", () => {
        const nodes: Node[] = [createNode("fill8")];
        // "Hello!!\0" - the qword (0x0021216f6c6c6548) is ABOVE the user-mode ceiling, so the
        // pointer-candidate path (which always wins) doesn't claim the tile first.
        const s = planSuggestions(nodes, viewOf([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0x21, 0x00]));
        expect(s).toHaveLength(1);
        expect(s[0].confidence).toBe("high");
        expect(s[0].fields).toEqual([{ typeId: "string", length: 8 }]);
        expect(s[0].reason).toContain("ASCII");
    });

    it("plausible floats are medium confidence with the value in the reason", () => {
        const nodes: Node[] = [createNode("fill4")];
        const s = planSuggestions(nodes, viewOf(f32(12.375)));
        expect(s).toHaveLength(1);
        expect(s[0].fields).toEqual(["float"]);
        expect(s[0].confidence).toBe("medium");
        expect(s[0].reason).toContain("float");
    });

    it("plain integers are low confidence", () => {
        const nodes: Node[] = [createNode("fill4")];
        const s = planSuggestions(nodes, viewOf([0x05, 0x00, 0x00, 0x00]));
        expect(s[0].fields).toEqual(["int32"]);
        expect(s[0].confidence).toBe("low");
    });

    it("bool-like bytes are medium confidence", () => {
        const nodes: Node[] = [createNode("fill1")];
        const s = planSuggestions(nodes, viewOf([0x01]));
        expect(s[0].fields).toEqual(["bool"]);
        expect(s[0].confidence).toBe("medium");
    });

    it("user-mode qwords become pointer candidates carrying a numeric fallback", () => {
        const nodes: Node[] = [createNode("fill8")];
        // 0x7ff600000010 - canonical user-mode address
        const s = planSuggestions(nodes, viewOf([0x10, 0x00, 0x00, 0x00, 0xf6, 0x7f, 0x00, 0x00]));
        expect(s[0].pointerTarget).toBe("0x7ff600000010");
        expect(isUsermodePointer(0x7ff600000010n)).toBe(true);
    });

    it("locked tiles are never planned", () => {
        const nodes: Node[] = [createNode("fill4", undefined, undefined, { locked: true }), createNode("fill4")];
        const s = planSuggestions(nodes, viewOf([1, 0, 0, 0, 2, 0, 0, 0]));
        expect(s).toHaveLength(1);
        expect(s[0].nodeId).toBe(nodes[1].id);
    });

    it("typed tiles are never planned (manual choices win)", () => {
        const nodes: Node[] = [createNode("int32"), createNode("fill4")];
        const s = planSuggestions(nodes, viewOf([1, 0, 0, 0, 2, 0, 0, 0]));
        expect(s.map((x) => x.nodeId)).toEqual([nodes[1].id]);
    });

    it("all-zero qwords stay untyped (no suggestion at all)", () => {
        const s = planSuggestions([createNode("fill8")], viewOf([0, 0, 0, 0, 0, 0, 0, 0]));
        expect(s).toHaveLength(0);
    });
});

describe("finalizeSuggestion", () => {
    const candidate = () =>
        planSuggestions([createNode("fill8")], viewOf([0x10, 0x00, 0x00, 0x00, 0xf6, 0x7f, 0x00, 0x00]))[0];

    it("a confirmed follow-check yields a verified high-confidence pointer", () => {
        const done = finalizeSuggestion(candidate(), true);
        expect(done.fields).toEqual(["pointer"]);
        expect(done.confidence).toBe("high");
        expect(done.reason).toContain("readable");
    });

    it("a failed follow-check keeps the numeric fallback - validation is never weakened", () => {
        const done = finalizeSuggestion(candidate(), false);
        expect(done.fields).not.toEqual(["pointer"]);
        expect(done.confidence).not.toBe("high");
        expect(done.reason).toContain("follow-check failed");
    });

    it("non-pointer suggestions pass through unchanged", () => {
        const s = planSuggestions([createNode("fill4")], viewOf([5, 0, 0, 0]))[0];
        expect(finalizeSuggestion(s, true)).toBe(s);
    });
});

describe("planGuesses compatibility", () => {
    it("mirrors planSuggestions (nodeId/pointerTarget/types)", () => {
        const nodes = padding(16);
        const view = viewOf([...f32(1.5), 0x05, 0, 0, 0, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0x00, 0x00]);
        const plans = planGuesses(nodes, view);
        const suggestions = planSuggestions(nodes, view);
        expect(plans.map((p) => p.nodeId)).toEqual(suggestions.map((s) => s.nodeId));
        expect(plans.map((p) => p.types)).toEqual(suggestions.map((s) => s.fields));
    });
});

describe("thresholds and field equality", () => {
    it("meetsThreshold ranks high > medium > low", () => {
        expect(meetsThreshold("high", "high")).toBe(true);
        expect(meetsThreshold("medium", "high")).toBe(false);
        expect(meetsThreshold("medium", "medium")).toBe(true);
        expect(meetsThreshold("low", "medium")).toBe(false);
        expect(meetsThreshold("high", "low")).toBe(true);
    });

    it("sameFields compares types and spans in order", () => {
        expect(sameFields(["float"], ["float"])).toBe(true);
        expect(sameFields(["float"], ["int32"])).toBe(false);
        expect(sameFields(["int32", "int32"], ["int32"])).toBe(false);
        expect(sameFields([{ typeId: "string", length: 8 }], [{ typeId: "string", length: 8 }])).toBe(true);
        expect(sameFields([{ typeId: "string", length: 8 }], [{ typeId: "string", length: 4 }])).toBe(false);
        expect(sameFields([{ typeId: "string", length: 8 }], ["float"])).toBe(false);
    });
});
