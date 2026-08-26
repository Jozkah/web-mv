import { describe, expect, it } from "vitest";
import {
    copyNode,
    createNode,
    offsets,
    setNodeLength,
    setNodeMeta,
    setNodeType,
    totalSize,
} from "../nodes/layout";
import type { Node } from "../nodes/types";

// Layout invariants for the new variable-size and metadata operations: retypes and resizes
// must consume/release padding so every later offset stays put, and metadata patches must
// never alter the layout at all.

const spanAfter = (nodes: Node[], index: number) => offsets(nodes).slice(index + 1);

describe("setNodeType with registry refs", () => {
    it("captures the ref span and consumes following padding", () => {
        const nodes = [createNode("fill8"), createNode("fill8"), createNode("int32", "tail")];
        const beforeTail = offsets(nodes)[2];
        const out = setNodeType(nodes, 0, "structref", { refName: "Vec3", length: 12 });
        expect(out[0].typeId).toBe("structref");
        expect(out[0].refName).toBe("Vec3");
        expect(out[0].length).toBe(12);
        expect(totalSize(out)).toBe(totalSize(nodes));
        expect(offsets(out)[out.findIndex((n) => n.name === "tail")]).toBe(beforeTail);
    });

    it("shrinking to an enumref releases padding after it", () => {
        const nodes = [createNode("fill8"), createNode("int32", "tail")];
        const out = setNodeType(nodes, 0, "enumref", { refName: "Team", length: 4 });
        expect(out[0].length).toBe(4);
        expect(totalSize(out)).toBe(totalSize(nodes));
        expect(offsets(out)[out.findIndex((n) => n.name === "tail")]).toBe(8);
    });

    it("vector types consume exactly their fixed span", () => {
        const nodes = [createNode("fill8"), createNode("fill8"), createNode("fill8")];
        const out = setNodeType(nodes, 0, "vec3");
        expect(offsets(out)).toEqual(expect.arrayContaining([0, 12]));
        expect(totalSize(out)).toBe(24);
    });

    it("keeps the lock but resets type-specific overrides on retype", () => {
        const nodes = [createNode("bits8", "flags", undefined, { bitNames: ["A"], locked: true })];
        const out = setNodeType(nodes, 0, "int8");
        expect(out[0].locked).toBe(true);
        expect(out[0].bitNames).toBeUndefined();
        expect(out[0].name).toBe("flags");
    });
});

describe("setNodeLength", () => {
    it("grows a string by consuming following padding", () => {
        const nodes = [createNode("string", "tag", 8), createNode("fill8"), createNode("int32", "tail")];
        const tailOff = offsets(nodes)[2];
        const out = setNodeLength(nodes, 0, 12);
        expect(out[0].length).toBe(12);
        expect(totalSize(out)).toBe(totalSize(nodes));
        expect(offsets(out)[out.findIndex((n) => n.name === "tail")]).toBe(tailOff);
    });

    it("shrinks a string by inserting padding after it", () => {
        const nodes = [createNode("string", "tag", 8), createNode("int32", "tail")];
        const out = setNodeLength(nodes, 0, 4);
        expect(out[0].length).toBe(4);
        expect(totalSize(out)).toBe(totalSize(nodes));
        expect(offsets(out)[out.findIndex((n) => n.name === "tail")]).toBe(8);
    });

    it("rounds a wstring span down to even and ignores fixed-size types", () => {
        const nodes = [createNode("wstring", "w", 8), createNode("fill8")];
        expect(setNodeLength(nodes, 0, 7)[0].length).toBe(6);
        const fixed = [createNode("int32")];
        expect(setNodeLength(fixed, 0, 12)).toEqual(fixed);
    });
});

describe("setNodeMeta", () => {
    it("stores supported overrides and never shifts offsets", () => {
        const nodes = [createNode("int32", "a"), createNode("int32", "b")];
        const before = spanAfter(nodes, 0);
        const out = setNodeMeta(nodes, 0, { displayFormat: "hex", endian: "be", locked: true });
        expect(out[0].displayFormat).toBe("hex");
        expect(out[0].endian).toBe("be");
        expect(out[0].locked).toBe(true);
        expect(spanAfter(out, 0)).toEqual(before);
    });

    it("drops overrides the type cannot support", () => {
        const out = setNodeMeta([createNode("bool")], 0, { displayFormat: "hex", endian: "be" });
        expect(out[0].displayFormat).toBeUndefined();
        expect(out[0].endian).toBeUndefined();
    });

    it("'auto' and 'le' clear back to the default representation", () => {
        const nodes = [createNode("int32", undefined, undefined, { displayFormat: "hex", endian: "be" })];
        const out = setNodeMeta(nodes, 0, { displayFormat: "auto", endian: "le" });
        expect(out[0].displayFormat).toBeUndefined();
        expect(out[0].endian).toBeUndefined();
    });

    it("empty bitNames clears them; unlock removes the flag", () => {
        const nodes = [createNode("bits8", undefined, undefined, { bitNames: ["A"], locked: true })];
        const out = setNodeMeta(nodes, 0, { bitNames: [], locked: false });
        expect(out[0].bitNames).toBeUndefined();
        expect(out[0].locked).toBeUndefined();
    });
});

describe("copyNode", () => {
    it("mints a new id but preserves every durable field", () => {
        const original = createNode("bits16", "flags", undefined, {
            displayFormat: "bin",
            endian: "be",
            bitNames: ["X", "Y"],
            locked: true,
        });
        const copy = copyNode(original);
        expect(copy.id).not.toBe(original.id);
        expect(copy.typeId).toBe("bits16");
        expect(copy.name).toBe("flags");
        expect(copy.displayFormat).toBe("bin");
        expect(copy.endian).toBe("be");
        expect(copy.bitNames).toEqual(["X", "Y"]);
        expect(copy.bitNames).not.toBe(original.bitNames); // deep-copied
        expect(copy.locked).toBe(true);
    });
});
