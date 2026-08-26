import { describe, expect, it } from "vitest";
import { decodeNode, formatBits, readMat4, readVec } from "../nodes/decode";
import { createNode } from "../nodes/layout";
import { exportClassToCpp } from "../export/cppExport";
import { NODE_TYPES, nodeByteSize, supportsDisplayFormat, supportsEndian, type Node } from "../nodes/types";

// The extended type system: sizes, context-aware decoding (display formats, endianness, named
// bits, registry refs, vectors/unions), and the C++ export for every new type.

const node = (typeId: Node["typeId"], extra?: Partial<Node>): Node => ({ id: "t", typeId, ...extra });

const viewOf = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

const f32bytes = (...values: number[]): number[] => {
    const b = new Uint8Array(values.length * 4);
    const dv = new DataView(b.buffer);
    values.forEach((v, i) => dv.setFloat32(i * 4, v, true));
    return [...b];
};

describe("type sizes", () => {
    it("new fixed types have the right spans", () => {
        expect(NODE_TYPES.vec2.size).toBe(8);
        expect(NODE_TYPES.vec3.size).toBe(12);
        expect(NODE_TYPES.vec4.size).toBe(16);
        expect(NODE_TYPES.mat4.size).toBe(64);
        expect(NODE_TYPES.funcptr.size).toBe(8);
        expect(NODE_TYPES.union4.size).toBe(4);
        expect(NODE_TYPES.union8.size).toBe(8);
    });
    it("ref nodes take their span from the captured length", () => {
        expect(nodeByteSize(node("structref", { refName: "S", length: 24 }))).toBe(24);
        expect(nodeByteSize(node("enumref", { refName: "E", length: 2 }))).toBe(2);
    });
});

describe("display formats", () => {
    const v = viewOf(0xff, 0x00, 0x00, 0x00);
    it("auto shows dec + hex; dec/hex/bin show one form", () => {
        expect(decodeNode(v, 0, node("uint32"))).toBe("255 (0xff)");
        expect(decodeNode(v, 0, node("uint32", { displayFormat: "dec" }))).toBe("255");
        expect(decodeNode(v, 0, node("uint32", { displayFormat: "hex" }))).toBe("0xff");
        expect(decodeNode(v, 0, node("uint8", { displayFormat: "bin" }))).toBe("1111 1111");
    });
    it("signed values stay signed in dec while hex shows the raw pattern", () => {
        const neg = viewOf(0xfe, 0xff);
        expect(decodeNode(neg, 0, node("int16", { displayFormat: "dec" }))).toBe("-2");
        expect(decodeNode(neg, 0, node("int16", { displayFormat: "hex" }))).toBe("0xfffe");
    });
    it("only numeric-ish types support a format override", () => {
        expect(supportsDisplayFormat("int32")).toBe(true);
        expect(supportsDisplayFormat("enumref")).toBe(true);
        expect(supportsDisplayFormat("float")).toBe(false);
        expect(supportsDisplayFormat("pointer")).toBe(false);
    });
});

describe("endianness", () => {
    it("decodes big-endian numerics when the node carries the override", () => {
        const v = viewOf(0x12, 0x34);
        expect(decodeNode(v, 0, node("uint16", { displayFormat: "hex" }))).toBe("0x3412");
        expect(decodeNode(v, 0, node("uint16", { displayFormat: "hex", endian: "be" }))).toBe("0x1234");
    });
    it("decodes big-endian floats", () => {
        const v = viewOf(0x3f, 0x80, 0x00, 0x00); // 1.0f big-endian
        expect(decodeNode(v, 0, node("float", { endian: "be" }))).toBe("1");
    });
    it("endian support is limited to plain multi-byte numerics", () => {
        expect(supportsEndian("uint32")).toBe(true);
        expect(supportsEndian("double")).toBe(true);
        expect(supportsEndian("pointer")).toBe(false);
        expect(supportsEndian("string")).toBe(false);
        expect(supportsEndian("uint8")).toBe(false);
        expect(supportsEndian("vec3")).toBe(false);
    });
});

describe("named bitfields", () => {
    it("appends the names of set bits", () => {
        const v = viewOf(0b0000_0101);
        const n = node("bits8", { bitNames: ["ALIVE", "GOD", "NOCLIP"] });
        expect(decodeNode(v, 0, n)).toBe("0000 0101 [ALIVE|NOCLIP]");
    });
    it("unnamed set bits are silently skipped", () => {
        expect(formatBits(0b10n, 8, ["A"], "auto")).toBe("0000 0010");
        expect(formatBits(0b11n, 8, ["A"], "auto")).toBe("0000 0011 [A]");
    });
    it("honors dec/hex formats for the numeric part", () => {
        expect(formatBits(5n, 8, ["A"], "hex")).toBe("0x5 [A]");
        expect(formatBits(5n, 8, undefined, "dec")).toBe("5");
    });
});

describe("registry references", () => {
    const refs = {
        formatEnum: (name: string, value: number) =>
            name === "Team" ? (value === 2 ? "RED" : `Team(${value})`) : undefined,
        hasStruct: (name: string) => name === "Vec3",
    };

    it("decodes enum members by name through the resolver", () => {
        const v = viewOf(0x02, 0, 0, 0);
        expect(decodeNode(v, 0, node("enumref", { refName: "Team", length: 4 }), refs)).toBe("RED");
        expect(decodeNode(viewOf(9, 0, 0, 0), 0, node("enumref", { refName: "Team", length: 4 }), refs)).toBe("Team(9)");
    });

    it("a missing enum falls back to the raw integer, flagged - never crashes", () => {
        const v = viewOf(0x07, 0, 0, 0);
        const out = decodeNode(v, 0, node("enumref", { refName: "Gone", length: 4 }), refs);
        expect(out).toContain("7");
        expect(out).toContain("missing enum Gone");
    });

    it("struct refs summarize; missing structs are flagged", () => {
        const v = viewOf(...new Array(24).fill(0));
        expect(decodeNode(v, 0, node("structref", { refName: "Vec3", length: 12 }), refs)).toBe("struct Vec3 (12B)");
        expect(decodeNode(v, 0, node("structref", { refName: "Gone", length: 12 }), refs)).toBe(
            "missing struct Gone (12B)",
        );
    });
});

describe("vectors, matrices, unions", () => {
    it("vec decodes as a tuple", () => {
        const v = viewOf(...f32bytes(1, 2.5));
        expect(decodeNode(v, 0, node("vec2"))).toBe("(1, 2.5)");
    });
    it("mat4 summarizes its diagonal", () => {
        const cells = new Array(16).fill(0);
        cells[0] = cells[5] = cells[10] = cells[15] = 1;
        const v = viewOf(...f32bytes(...cells));
        expect(decodeNode(v, 0, node("mat4"))).toBe("diag(1, 1, 1, 1)");
        expect(readMat4(v, 0)).toEqual(cells);
    });
    it("readVec reads N floats and bounds-checks", () => {
        const v = viewOf(...f32bytes(1, 2, 3));
        expect(readVec(v, 0, 3)).toEqual([1, 2, 3]);
        expect(readVec(v, 0, 4)).toBeUndefined();
    });
    it("unions show every interpretation at once", () => {
        const v = viewOf(...f32bytes(1)); // 0x3f800000
        expect(decodeNode(v, 0, node("union4"))).toBe("1065353216 · 1f · 0x3f800000");
    });
    it("out-of-bounds decodes return undefined", () => {
        expect(decodeNode(viewOf(0, 0), 0, node("vec2"))).toBeUndefined();
    });
});

describe("C++ export of new types", () => {
    it("emits arrays, unions, refs, and the size assert", () => {
        const cls = {
            id: "c1",
            name: "Entity",
            address: "0x1000",
            nodes: [
                createNode("vec3", "pos"),
                createNode("mat4", "xform"),
                createNode("funcptr", "vtable_fn"),
                createNode("union4", "packed"),
                createNode("enumref", "team", 4, { refName: "Team" }),
                createNode("structref", "stats", 24, { refName: "Stats" }),
                createNode("bits8", "flags", undefined, { bitNames: ["ALIVE", "GOD"] }),
                createNode("uint32", "seed", undefined, { endian: "be" }),
            ],
        };
        const cpp = exportClassToCpp(cls);
        expect(cpp).toContain("float pos[3]; // 0x0 (vec3)");
        expect(cpp).toContain("float xform[16]; // 0xc (mat4)");
        expect(cpp).toContain("uintptr_t vtable_fn; // 0x4c");
        expect(cpp).toContain("union { int32_t as_int; float as_float; } packed; // 0x54");
        expect(cpp).toContain("int32_t team; // 0x58 (enum Team)");
        expect(cpp).toContain("Stats stats; // 0x5c (0x18 bytes; requires Stats definition)");
        expect(cpp).toContain("uint8_t flags; // 0x74 · bits: 0=ALIVE 1=GOD");
        expect(cpp).toContain("uint32_t seed; // 0x75 · big-endian");
        expect(cpp).toContain('static_assert(sizeof(Entity) == 0x79, "Entity size mismatch");');
    });
});
