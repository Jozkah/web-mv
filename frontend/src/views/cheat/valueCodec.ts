// Value <-> little-endian byte codecs for the Cheat Table. The agent's `read` returns and
// `write` accepts lowercase hex byte strings; these translate typed values across that seam.

export type ValueType =
    | "u8" | "u16" | "u32" | "u64"
    | "i8" | "i16" | "i32" | "i64"
    | "f32" | "f64";

export const VALUE_TYPES: ValueType[] = [
    "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64",
];

export function byteWidth(t: ValueType): number {
    switch (t) {
        case "u8": case "i8": return 1;
        case "u16": case "i16": return 2;
        case "u32": case "i32": case "f32": return 4;
        case "u64": case "i64": case "f64": return 8;
    }
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const n = Math.floor(clean.length / 2);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function bytesToHex(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
}

/** Decode agent-returned little-endian hex into a display string. Returns "?" on short data. */
export function decodeValue(hex: string, type: ValueType): string {
    const width = byteWidth(type);
    const bytes = hexToBytes(hex);
    if (bytes.length < width) return "?";
    const view = new DataView(bytes.buffer, bytes.byteOffset, width);
    switch (type) {
        case "u8": return String(view.getUint8(0));
        case "i8": return String(view.getInt8(0));
        case "u16": return String(view.getUint16(0, true));
        case "i16": return String(view.getInt16(0, true));
        case "u32": return String(view.getUint32(0, true));
        case "i32": return String(view.getInt32(0, true));
        case "u64": return view.getBigUint64(0, true).toString();
        case "i64": return view.getBigInt64(0, true).toString();
        case "f32": return trimFloat(view.getFloat32(0, true));
        case "f64": return trimFloat(view.getFloat64(0, true));
    }
}

function trimFloat(n: number): string {
    if (!Number.isFinite(n)) return String(n);
    // Avoid noisy trailing precision (e.g. 99.9000015) while keeping enough for game floats.
    return String(Number(n.toFixed(6)));
}

/**
 * Encode a user-entered value into a little-endian hex byte string for `write`.
 * Throws on unparseable input so the caller can surface a validation error.
 */
export function encodeValue(input: string, type: ValueType): string {
    const width = byteWidth(type);
    const bytes = new Uint8Array(width);
    const view = new DataView(bytes.buffer);
    const raw = input.trim();
    if (raw === "") throw new Error("empty value"); // else BigInt("")/Number("") silently → 0

    if (type === "f32" || type === "f64") {
        const f = Number(raw);
        if (!Number.isFinite(f) && raw !== "Infinity" && raw !== "-Infinity" && raw !== "NaN") {
            throw new Error(`not a number: ${input}`);
        }
        if (type === "f32") view.setFloat32(0, f, true);
        else view.setFloat64(0, f, true);
        return bytesToHex(bytes);
    }

    // Integer types: accept decimal or 0x-hex, wrap into the type width (two's complement).
    let v: bigint;
    try {
        v = BigInt(raw);
    } catch {
        throw new Error(`not an integer: ${input}`);
    }
    const bits = BigInt(width * 8);
    const mask = (1n << bits) - 1n;
    const wrapped = ((v % (1n << bits)) + (1n << bits)) & mask; // handles negatives
    for (let i = 0; i < width; i++) {
        bytes[i] = Number((wrapped >> BigInt(i * 8)) & 0xffn);
    }
    return bytesToHex(bytes);
}
