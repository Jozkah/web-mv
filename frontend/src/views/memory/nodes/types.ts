import { formatBinary, formatFloat, formatInt } from "./format";

// The node type registry. A node is either an interpreted field (a selectable primitive that
// decodes its bytes into a display value) or an untyped fill (an internal tile with a byte
// size but no value - the row still shows its raw bytes in the always-on hex column). Adding
// a primitive is one entry in NODE_TYPES; fills are bookkeeping and never reach the picker.
// Pointers decode to just their target address; the row augments that with the live target
// preview + RTTI class name.

export type PrimitiveTypeId =
    | "int8"
    | "int16"
    | "int32"
    | "int64"
    | "uint8"
    | "uint16"
    | "uint32"
    | "uint64"
    | "float"
    | "double"
    | "bool"
    | "pointer"
    | "string"
    | "wstring"
    | "bits8"
    | "bits16"
    | "bits32"
    | "bits64";

export type StringTypeId = "string" | "wstring";

export type FillTypeId = "fill1" | "fill2" | "fill4" | "fill8";

export type NodeTypeId = PrimitiveTypeId | FillTypeId;

export type NodeCategory = "fill" | "int" | "uint" | "float" | "bool" | "pointer" | "string";

/** One field in a class definition. Offset is derived from position, never stored. `length` is
 *  the byte span of a variable-length string field; it is unset (and ignored) for fixed types. */
export interface Node {
    id: string;
    typeId: NodeTypeId;
    name?: string;
    length?: number;
}

export interface NodeType {
    id: NodeTypeId;
    label: string;
    size: number;
    category: NodeCategory;
    /** Decode the bytes at `offset`, or undefined for an untyped fill (no value). */
    decode(view: DataView, offset: number): string | undefined;
}

function fill(id: FillTypeId, size: number): NodeType {
    return { id, label: "untyped", size, category: "fill", decode: () => undefined };
}

export const NODE_TYPES: Record<NodeTypeId, NodeType> = {
    fill1: fill("fill1", 1),
    fill2: fill("fill2", 2),
    fill4: fill("fill4", 4),
    fill8: fill("fill8", 8),

    int8: { id: "int8", label: "int8", size: 1, category: "int", decode: (v, o) => formatInt(v.getInt8(o), v.getUint8(o).toString(16)) },
    int16: { id: "int16", label: "int16", size: 2, category: "int", decode: (v, o) => formatInt(v.getInt16(o, true), v.getUint16(o, true).toString(16)) },
    int32: { id: "int32", label: "int32", size: 4, category: "int", decode: (v, o) => formatInt(v.getInt32(o, true), v.getUint32(o, true).toString(16)) },
    int64: { id: "int64", label: "int64", size: 8, category: "int", decode: (v, o) => formatInt(v.getBigInt64(o, true), v.getBigUint64(o, true).toString(16)) },

    uint8: { id: "uint8", label: "uint8", size: 1, category: "uint", decode: (v, o) => formatInt(v.getUint8(o), v.getUint8(o).toString(16)) },
    uint16: { id: "uint16", label: "uint16", size: 2, category: "uint", decode: (v, o) => formatInt(v.getUint16(o, true), v.getUint16(o, true).toString(16)) },
    uint32: { id: "uint32", label: "uint32", size: 4, category: "uint", decode: (v, o) => formatInt(v.getUint32(o, true), v.getUint32(o, true).toString(16)) },
    uint64: { id: "uint64", label: "uint64", size: 8, category: "uint", decode: (v, o) => formatInt(v.getBigUint64(o, true), v.getBigUint64(o, true).toString(16)) },

    float: { id: "float", label: "float", size: 4, category: "float", decode: (v, o) => formatFloat(v.getFloat32(o, true)) },
    double: { id: "double", label: "double", size: 8, category: "float", decode: (v, o) => formatFloat(v.getFloat64(o, true), 6) },

    bool: { id: "bool", label: "bool", size: 1, category: "bool", decode: (v, o) => (v.getUint8(o) !== 0 ? "true" : "false") },

    pointer: { id: "pointer", label: "pointer", size: 8, category: "pointer", decode: (v, o) => `0x${v.getBigUint64(o, true).toString(16)}` },

    // Variable-length strings. `size` is the per-char width; the real byte span lives on the node
    // (`length`). They decode length-aware in NodeRow, so the registry decode is unused.
    string: { id: "string", label: "string", size: 1, category: "string", decode: () => undefined },
    wstring: { id: "wstring", label: "wstring", size: 2, category: "string", decode: () => undefined },

    // Bitfields: an unsigned integer shown as fixed-width binary, for flag/mask fields.
    bits8: { id: "bits8", label: "bits8", size: 1, category: "uint", decode: (v, o) => formatBinary(v.getUint8(o), 8) },
    bits16: { id: "bits16", label: "bits16", size: 2, category: "uint", decode: (v, o) => formatBinary(v.getUint16(o, true), 16) },
    bits32: { id: "bits32", label: "bits32", size: 4, category: "uint", decode: (v, o) => formatBinary(v.getUint32(o, true), 32) },
    bits64: { id: "bits64", label: "bits64", size: 8, category: "uint", decode: (v, o) => formatBinary(v.getBigUint64(o, true), 64) },
};

/** The selectable primitives, ordered, for the type-picker menus (fills are excluded). */
export const NODE_TYPE_LIST: readonly NodeType[] = [
    NODE_TYPES.int8,
    NODE_TYPES.int16,
    NODE_TYPES.int32,
    NODE_TYPES.int64,
    NODE_TYPES.uint8,
    NODE_TYPES.uint16,
    NODE_TYPES.uint32,
    NODE_TYPES.uint64,
    NODE_TYPES.float,
    NODE_TYPES.double,
    NODE_TYPES.bool,
    NODE_TYPES.pointer,
    NODE_TYPES.string,
    NODE_TYPES.wstring,
    NODE_TYPES.bits8,
    NODE_TYPES.bits16,
    NODE_TYPES.bits32,
    NODE_TYPES.bits64,
];

export function nodeType(id: NodeTypeId): NodeType {
    return NODE_TYPES[id];
}

// Numeric value of a node's bytes for the value-history sparkline, or undefined for types that
// aren't a single number (fills, bool, pointer, strings). 64-bit ints are coerced to Number - the
// sparkline only needs a rough magnitude, not exactness.
export function nodeNumericValue(view: DataView, offset: number, id: NodeTypeId): number | undefined {
    if (offset + NODE_TYPES[id].size > view.byteLength) return undefined;
    switch (id) {
        case "int8": return view.getInt8(offset);
        case "uint8": return view.getUint8(offset);
        case "int16": return view.getInt16(offset, true);
        case "uint16": return view.getUint16(offset, true);
        case "int32": return view.getInt32(offset, true);
        case "uint32": return view.getUint32(offset, true);
        case "int64": return Number(view.getBigInt64(offset, true));
        case "uint64": return Number(view.getBigUint64(offset, true));
        case "float": return view.getFloat32(offset, true);
        case "double": return view.getFloat64(offset, true);
        default: return undefined;
    }
}

// Build an SVG polyline `points` string for a sparkline of `values` in a `w`x`h` box. Flat when
// all values are equal (min===max); newest value on the right.
export function sparklinePoints(values: number[], w: number, h: number): string {
    if (values.length < 2) return "";
    let min = values[0];
    let max = values[0];
    for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const span = max - min || 1;
    const step = w / (values.length - 1);
    return values
        .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
        .join(" ");
}

/** Fixed size of a type by its unit; for a string this is the per-char width, not the span. */
export function nodeSize(id: NodeTypeId): number {
    return NODE_TYPES[id].size;
}

export function isStringType(id: NodeTypeId): id is StringTypeId {
    return id === "string" || id === "wstring";
}

/** Byte span a node actually occupies: the fixed type size, or a string's per-node `length`. */
export function nodeByteSize(node: Node): number {
    return isStringType(node.typeId) ? node.length ?? 0 : NODE_TYPES[node.typeId].size;
}

/** An untyped fill node shows only its raw bytes - it has no interpreted value. */
export function isFill(id: NodeTypeId): boolean {
    return NODE_TYPES[id].category === "fill";
}

// A planned field from the auto-guesser: a bare id for a fixed primitive, or a string carrying
// its byte span. The helpers below normalise the two forms so callers don't branch inline.
export type GuessField = NodeTypeId | { typeId: StringTypeId; length: number };

export function fieldType(f: GuessField): NodeTypeId {
    return typeof f === "string" ? f : f.typeId;
}
export function fieldLength(f: GuessField): number | undefined {
    return typeof f === "string" ? undefined : f.length;
}
export function fieldSize(f: GuessField): number {
    return typeof f === "string" ? nodeSize(f) : f.length;
}
