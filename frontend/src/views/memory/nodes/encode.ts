import {
    isBitsType,
    isRefType,
    isStringType,
    nodeByteSize,
    NODE_TYPES,
    type Node,
} from "./types";

// Pure encoders for inline value editing: user text in, hex byte string (agent wire format,
// lowercase pairs) out - or a specific validation error. Everything the write path needs to
// know about widths, bounds, signedness, endianness, and string capacity lives here so it can
// be unit-tested without a UI or a process.

export type EncodeResult = { ok: true; hex: string } | { ok: false; error: string };

/** What encodeValue needs from the dataTypes registry to resolve enum member names. */
export interface EncodeRefs {
    /** Resolve an enum member name to its value, or undefined when unknown. */
    enumValue?: (enumName: string, memberName: string) => number | undefined;
}

const err = (error: string): EncodeResult => ({ ok: false, error });

function bytesToHex(bytes: Uint8Array): string {
    let out = "";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out;
}

/** Parse an integer as decimal ("-42"), hex ("0x2a"), or binary ("0b1010"). */
export function parseIntText(text: string): bigint | undefined {
    const t = text.trim().toLowerCase();
    if (/^[+-]?0x[0-9a-f]+$/.test(t)) {
        const neg = t.startsWith("-");
        const body = t.replace(/^[+-]/, "").slice(2);
        const v = BigInt(`0x${body}`);
        return neg ? -v : v;
    }
    if (/^[+-]?0b[01]+$/.test(t)) {
        const neg = t.startsWith("-");
        const body = t.replace(/^[+-]/, "").slice(2);
        const v = BigInt(`0b${body}`);
        return neg ? -v : v;
    }
    if (/^[+-]?[0-9]+$/.test(t)) return BigInt(t);
    return undefined;
}

function intBounds(bits: number, signed: boolean): { min: bigint; max: bigint } {
    if (signed) {
        const half = 1n << BigInt(bits - 1);
        return { min: -half, max: half - 1n };
    }
    return { min: 0n, max: (1n << BigInt(bits)) - 1n };
}

/** Encode an integer into `size` bytes, range-checked; `be` flips the byte order. */
export function encodeInt(text: string, size: number, signed: boolean, be: boolean, label: string): EncodeResult {
    const value = parseIntText(text);
    if (value === undefined) return err(`not a number (use decimal, 0x hex, or 0b binary)`);
    const { min, max } = intBounds(size * 8, signed);
    if (value < min || value > max) return err(`value out of range for ${label} (${min}..${max})`);

    // Two's-complement into the unsigned bit pattern of the same width.
    const unsigned = value < 0n ? value + (1n << BigInt(size * 8)) : value;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        const shift = BigInt(8 * (be ? size - 1 - i : i));
        bytes[i] = Number((unsigned >> shift) & 0xffn);
    }
    return { ok: true, hex: bytesToHex(bytes) };
}

const FLOAT_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function encodeFloat(text: string, double: boolean, be: boolean): EncodeResult {
    const t = text.trim();
    if (!FLOAT_RE.test(t)) return err("not a valid number");
    const value = Number(t);
    if (!Number.isFinite(value)) return err("value is not finite");
    if (!double && Number.isFinite(value) && value !== 0 && Math.abs(value) > 3.4028235e38) {
        return err("magnitude exceeds float range");
    }
    const bytes = new Uint8Array(double ? 8 : 4);
    const dv = new DataView(bytes.buffer);
    if (double) dv.setFloat64(0, value, !be);
    else dv.setFloat32(0, value, !be);
    return { ok: true, hex: bytesToHex(bytes) };
}

export function encodeBool(text: string): EncodeResult {
    const t = text.trim().toLowerCase();
    if (t === "true" || t === "1") return { ok: true, hex: "01" };
    if (t === "false" || t === "0") return { ok: true, hex: "00" };
    return err("expected true/false or 1/0");
}

export function encodePointer(text: string): EncodeResult {
    const t = text.trim().toLowerCase();
    const body = t.startsWith("0x") ? t.slice(2) : t;
    if (!/^[0-9a-f]{1,16}$/.test(body)) return err("expected a hex address (0x...)");
    return encodeInt(`0x${body}`, 8, false, false, "pointer");
}

/** ASCII string into a fixed `capacity`-byte field: NUL-padded to the full span so the write
 *  always covers the whole field (and terminates when shorter than capacity). */
export function encodeAscii(text: string, capacity: number): EncodeResult {
    if (capacity <= 0) return err("field has no capacity");
    const bytes = new Uint8Array(capacity);
    if (text.length > capacity) return err(`too long: ${text.length} chars > ${capacity}-byte field`);
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c > 0x7f) return err(`character "${text[i]}" is not ASCII`);
        bytes[i] = c;
    }
    return { ok: true, hex: bytesToHex(bytes) };
}

/** UTF-16LE string into a fixed `capacity`-byte field, NUL-padded like encodeAscii. */
export function encodeUtf16(text: string, capacity: number): EncodeResult {
    if (capacity <= 0) return err("field has no capacity");
    const byteLen = text.length * 2;
    if (byteLen > capacity) return err(`too long: ${byteLen} bytes > ${capacity}-byte field`);
    const bytes = new Uint8Array(capacity);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < text.length; i++) dv.setUint16(i * 2, text.charCodeAt(i), true);
    return { ok: true, hex: bytesToHex(bytes) };
}

/** N comma/space-separated floats into consecutive 4-byte little-endian slots. */
export function encodeFloatList(text: string, count: number): EncodeResult {
    const parts = text.split(/[,\s]+/).filter((p) => p.length > 0);
    if (parts.length !== count) return err(`expected ${count} numbers, got ${parts.length}`);
    const bytes = new Uint8Array(count * 4);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) {
        if (!FLOAT_RE.test(parts[i])) return err(`"${parts[i]}" is not a valid number`);
        dv.setFloat32(i * 4, Number(parts[i]), true);
    }
    return { ok: true, hex: bytesToHex(bytes) };
}

/**
 * Encode edited text for a node into the hex bytes to write at its offset. Fills, unions,
 * and struct references are not editable (ambiguous target representation); everything else
 * respects the node's byte span, endian override, and (for enumrefs) member names.
 */
export function encodeValue(node: Node, text: string, refs: EncodeRefs = {}): EncodeResult {
    const id = node.typeId;
    const be = node.endian === "be";
    const size = nodeByteSize(node);

    if (isStringType(id)) {
        return id === "wstring" ? encodeUtf16(text, size) : encodeAscii(text, size);
    }
    if (isBitsType(id)) {
        return encodeInt(text, NODE_TYPES[id].size, false, be, NODE_TYPES[id].label);
    }
    if (isRefType(id)) {
        if (id === "structref") return err("struct fields are edited via their inner fields");
        const width = size === 1 || size === 2 || size === 4 || size === 8 ? size : 0;
        if (width === 0) return err(`enum width ${size} is not writable`);
        const named = node.refName ? refs.enumValue?.(node.refName, text.trim()) : undefined;
        if (named !== undefined) return encodeInt(String(named), width, true, false, "enum");
        return encodeInt(text, width, true, false, `enum (${width * 8}-bit)`);
    }

    switch (id) {
        case "int8": case "int16": case "int32": case "int64":
            return encodeInt(text, NODE_TYPES[id].size, true, be, NODE_TYPES[id].label);
        case "uint8": case "uint16": case "uint32": case "uint64":
            return encodeInt(text, NODE_TYPES[id].size, false, be, NODE_TYPES[id].label);
        case "float":
            return encodeFloat(text, false, be);
        case "double":
            return encodeFloat(text, true, be);
        case "bool":
            return encodeBool(text);
        case "pointer": case "funcptr":
            return encodePointer(text);
        case "vec2":
            return encodeFloatList(text, 2);
        case "vec3":
            return encodeFloatList(text, 3);
        case "vec4":
            return encodeFloatList(text, 4);
        case "mat4":
            return encodeFloatList(text, 16);
        default:
            return err(`${NODE_TYPES[id].label} fields are not editable`);
    }
}

/** Whether a node's value can be edited inline at all (independent of live/attach state). */
export function isEditableType(node: Node): boolean {
    const cat = NODE_TYPES[node.typeId].category;
    if (cat === "fill" || cat === "union") return false;
    if (node.typeId === "structref") return false;
    return true;
}

/**
 * The text to prefill the editor with, derived from the live bytes: a canonical, re-parseable
 * form of the current value (decimal ints, bare float lists, hex pointers, raw strings).
 */
export function editText(node: Node, view: DataView, offset: number): string {
    const size = nodeByteSize(node);
    if (offset + size > view.byteLength) return "";
    const be = node.endian === "be";
    const id = node.typeId;

    const uint = (w: number): bigint => {
        switch (w) {
            case 1: return BigInt(view.getUint8(offset));
            case 2: return BigInt(view.getUint16(offset, !be));
            case 4: return BigInt(view.getUint32(offset, !be));
            default: return view.getBigUint64(offset, !be);
        }
    };
    const int = (w: number): bigint => {
        switch (w) {
            case 1: return BigInt(view.getInt8(offset));
            case 2: return BigInt(view.getInt16(offset, !be));
            case 4: return BigInt(view.getInt32(offset, !be));
            default: return view.getBigInt64(offset, !be);
        }
    };
    const floats = (count: number): string => {
        const parts: string[] = [];
        for (let i = 0; i < count; i++) parts.push(String(view.getFloat32(offset + i * 4, true)));
        return parts.join(", ");
    };

    if (isStringType(id)) {
        // Raw decoded text up to the NUL, without the '.' placeholders decode uses for display.
        const wide = id === "wstring";
        const step = wide ? 2 : 1;
        let out = "";
        for (let i = 0; i + step <= size; i += step) {
            const c = wide ? view.getUint16(offset + i, true) : view.getUint8(offset + i);
            if (c === 0) break;
            out += String.fromCharCode(c);
        }
        return out;
    }
    if (isBitsType(id)) return `0x${uint(NODE_TYPES[id].size).toString(16)}`;
    if (id === "enumref") {
        const width = size === 1 || size === 2 || size === 4 || size === 8 ? size : 4;
        return int(width).toString();
    }

    switch (id) {
        case "int8": case "int16": case "int32": case "int64":
            return int(NODE_TYPES[id].size).toString();
        case "uint8": case "uint16": case "uint32": case "uint64":
            return uint(NODE_TYPES[id].size).toString();
        case "float": return String(be ? view.getFloat32(offset, false) : view.getFloat32(offset, true));
        case "double": return String(be ? view.getFloat64(offset, false) : view.getFloat64(offset, true));
        case "bool": return view.getUint8(offset) !== 0 ? "true" : "false";
        case "pointer": case "funcptr": return `0x${view.getBigUint64(offset, true).toString(16)}`;
        case "vec2": return floats(2);
        case "vec3": return floats(3);
        case "vec4": return floats(4);
        case "mat4": return floats(16);
        default: return "";
    }
}
