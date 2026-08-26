import { describe, expect, it } from "vitest";
import { captureBaseline } from "../nodes/baseline";
import { filterNodes, indexAtOffset, nearestVisiblePosition, parseGotoOffset } from "../nodes/filter";
import { createNode, deleteNode, insertBytes, offsets, renameNode, setNodeType } from "../nodes/layout";
import type { Node } from "../nodes/types";

// Search/filter over the node list. The invariant under test everywhere: results are ORIGINAL
// node indices, so structural actions keep addressing the right node under any filter.

const mkNodes = (): Node[] => [
    createNode("int32", "health"), // 0 @0x0
    createNode("float", "speed"), // 1 @0x4
    createNode("pointer", "world"), // 2 @0x8
    createNode("fill8"), // 3 @0x10
    createNode("uint8"), // 4 @0x18 (unnamed, numeric)
];

const viewOf = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe("filterNodes", () => {
    it("matches by field name, case-insensitively", () => {
        expect(filterNodes({ nodes: mkNodes(), query: "HEALTH", mode: "all" })).toEqual([0]);
    });

    it("matches by type label", () => {
        expect(filterNodes({ nodes: mkNodes(), query: "float", mode: "all" })).toEqual([1]);
        expect(filterNodes({ nodes: mkNodes(), query: "pointer", mode: "all" })).toEqual([2]);
    });

    it("matches by offset in hex forms", () => {
        expect(filterNodes({ nodes: mkNodes(), query: "0x8", mode: "all" })).toContain(2);
        expect(filterNodes({ nodes: mkNodes(), query: "18", mode: "all" })).toContain(4);
    });

    it("matches by absolute address when a base is given", () => {
        const out = filterNodes({ nodes: mkNodes(), query: "100c", mode: "all", base: 0x1008n });
        // base 0x1008 + offset 0x4 = 0x100c -> the float at original index 1
        expect(out).toEqual([1]);
    });

    it("matches by displayed value when a snapshot is given", () => {
        const bytes = new Array(25).fill(0);
        bytes[0] = 0x2a; // int32 42 at offset 0
        const out = filterNodes({ nodes: mkNodes(), query: "42", mode: "all", view: viewOf(bytes) });
        expect(out).toContain(0);
    });

    it("filters pointers / unnamed / numeric", () => {
        expect(filterNodes({ nodes: mkNodes(), query: "", mode: "pointers" })).toEqual([2]);
        expect(filterNodes({ nodes: mkNodes(), query: "", mode: "unnamed" })).toEqual([4]);
        expect(filterNodes({ nodes: mkNodes(), query: "", mode: "numeric" })).toEqual([0, 1, 4]);
    });

    it("'changed' mode needs both a snapshot and a baseline", () => {
        const nodes = mkNodes();
        const before = new Array(25).fill(0);
        const after = [...before];
        after[4] = 7; // second field (float at 0x4) changed
        const baseline = captureBaseline("k", viewOf(before));
        expect(filterNodes({ nodes, query: "", mode: "changed", view: viewOf(after), baseline })).toEqual([1]);
        expect(filterNodes({ nodes, query: "", mode: "changed", view: viewOf(after) })).toEqual([]);
        expect(filterNodes({ nodes, query: "", mode: "changed", baseline })).toEqual([]);
    });

    it("preserves original indices so structural edits hit the right node", () => {
        let nodes = mkNodes();
        // Filter down to the pointer, then delete "through" the filtered result.
        const visible = filterNodes({ nodes, query: "", mode: "pointers" });
        expect(visible).toEqual([2]);
        nodes = deleteNode(nodes, visible[0]);
        expect(nodes.map((n) => n.name)).toEqual(["health", "speed", undefined, undefined]);

        // Rename and retype through fresh filtered indices after the layout shifted.
        const vis2 = filterNodes({ nodes, query: "speed", mode: "all" });
        nodes = renameNode(nodes, vis2[0], "velocity");
        expect(nodes[1].name).toBe("velocity");
        nodes = setNodeType(nodes, vis2[0], "double");
        expect(nodes[1].typeId).toBe("double");

        // Insert above a filtered index: padding lands before the right node.
        const vis3 = filterNodes({ nodes, query: "velocity", mode: "all" });
        const before = offsets(nodes)[vis3[0]];
        nodes = insertBytes(nodes, vis3[0], 8);
        expect(offsets(nodes)[nodes.findIndex((n) => n.name === "velocity")]).toBe(before + 8);
    });
});

describe("parseGotoOffset", () => {
    it("reads hex with or without 0x", () => {
        expect(parseGotoOffset("0x1C")).toBe(0x1c);
        expect(parseGotoOffset("1c")).toBe(0x1c);
        expect(parseGotoOffset("10")).toBe(0x10);
    });
    it("rejects malformed input", () => {
        expect(parseGotoOffset("")).toBeUndefined();
        expect(parseGotoOffset("zz")).toBeUndefined();
        expect(parseGotoOffset("-4")).toBeUndefined();
    });
});

describe("indexAtOffset", () => {
    it("finds the node containing a byte offset", () => {
        const nodes = mkNodes();
        expect(indexAtOffset(nodes, 0)).toBe(0);
        expect(indexAtOffset(nodes, 0x5)).toBe(1); // inside the float
        expect(indexAtOffset(nodes, 0x10)).toBe(3);
        expect(indexAtOffset(nodes, 0x18)).toBe(4);
        expect(indexAtOffset(nodes, 0x19)).toBeUndefined(); // past the end
    });
});

describe("nearestVisiblePosition", () => {
    it("returns the exact position when visible, else the nearest earlier row", () => {
        expect(nearestVisiblePosition([0, 2, 4], 2)).toBe(1);
        expect(nearestVisiblePosition([0, 2, 4], 3)).toBe(1);
        expect(nearestVisiblePosition([2, 4], 0)).toBe(0);
        expect(nearestVisiblePosition([], 3)).toBe(0);
    });
});
