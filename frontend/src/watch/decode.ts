import {
    fixedWidth,
    isStringType,
    type DecodedWatchValue,
    type MemoryWatchDefinition,
    type WatchDisplayBase,
    type WatchEndianness,
    type WatchValueKind,
    type WatchValueType,
} from "./model";

// Typed value decoding for Memory Watch. Input is the raw little/big-endian bytes returned by an
// Angel read (as a lowercase hex string, matching the read_result encoding). Output preserves the
// raw bytes alongside a canonical decoded value: BigInt for 64-bit ints and pointers (never a lossy
// JS number), number for floats, string for text. Partial reads and invalid encodings are explicit.

export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const n = clean.length >> 1;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export function bytesToHex(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
}

function kindOf(t: WatchValueType): WatchValueKind {
    switch (t) {
        case "int8":
        case "int16":
        case "int32":
        case "int64":
            return "int";
        case "uint8":
        case "uint16":
        case "uint32":
        case "uint64":
            return "uint";
        case "float32":
        case "float64":
            return "float";
        case "bool":
            return "bool";
        case "pointer":
            return "pointer";
        case "bytes":
            return "bytes";
        default:
            return "string";
    }
}

function partial(kind: WatchValueKind, hex: string, need: number): DecodedWatchValue {
    return { ok: false, kind, bytesHex: hex, byteLength: hex.length >> 1, display: "—", error: `partial read (need ${need} bytes)` };
}

// Decode an integer of `width` bytes from `bytes` at offset 0, honoring endianness and sign.
function readInt(bytes: Uint8Array, width: number, signed: boolean, endian: WatchEndianness): bigint {
    let v = 0n;
    if (endian === "little") {
        for (let i = width - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    } else {
        for (let i = 0; i < width; i++) v = (v << 8n) | BigInt(bytes[i]);
    }
    if (signed) {
        const bits = BigInt(width * 8);
        const signBit = 1n << (bits - 1n);
        if (v & signBit) v -= 1n << bits;
    }
    return v;
}

function toBinary(v: bigint, width: number): string {
    const bits = width * 8;
    const mask = (1n << BigInt(bits)) - 1n;
    const u = v < 0n ? (v & mask) : v;
    return "0b" + u.toString(2).padStart(bits, "0");
}

function formatInt(v: bigint, width: number, base: WatchDisplayBase): string {
    switch (base) {
        case "hex": {
            const bits = BigInt(width * 8);
            const mask = (1n << bits) - 1n;
            const u = v < 0n ? v & mask : v;
            return "0x" + u.toString(16);
        }
        case "binary":
            return toBinary(v, width);
        case "char":
            return v >= 32n && v < 127n ? `'${String.fromCharCode(Number(v))}'` : v.toString();
        case "decimal":
        case "auto":
        default:
            return v.toString();
    }
}

function formatFloat(n: number): string {
    if (Number.isNaN(n)) return "NaN";
    if (n === Infinity) return "Infinity";
    if (n === -Infinity) return "-Infinity";
    // Trim noisy precision but keep enough for typical game floats.
    return String(Number(n.toFixed(6)));
}

function decodeString(bytes: Uint8Array, type: WatchValueType): { text: string; error?: string } {
    try {
        if (type === "ascii") {
            let s = "";
            for (const b of bytes) {
                if (b === 0) break;
                s += b >= 32 && b < 127 ? String.fromCharCode(b) : ".";
            }
            return { text: s };
        }
        if (type === "utf8") {
            // Cut at first NUL, then decode; `fatal` surfaces invalid sequences.
            let end = bytes.length;
            for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) { end = i; break; }
            const dec = new TextDecoder("utf-8", { fatal: false });
            return { text: dec.decode(bytes.subarray(0, end)) };
        }
        // utf16le / utf16be — the type name fixes the byte order (endian arg is not consulted here).
        const le = type === "utf16le";
        const label = type === "utf16be" ? "utf-16be" : "utf-16le";
        let end = bytes.length - (bytes.length % 2);
        for (let i = 0; i + 1 < bytes.length; i += 2) {
            const unit = le ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
            if (unit === 0) { end = i; break; }
        }
        const dec = new TextDecoder(label, { fatal: false });
        return { text: dec.decode(bytes.subarray(0, end)) };
    } catch (e) {
        return { text: "", error: e instanceof Error ? e.message : "decode failure" };
    }
}

export interface DecodeOptions {
    valueType: WatchValueType;
    endianness: WatchEndianness;
    byteLength?: number;
    displayBase: WatchDisplayBase;
}

export function decodeWatchValue(hex: string, opts: DecodeOptions): DecodedWatchValue {
    const kind = kindOf(opts.valueType);
    const bytes = hexToBytes(hex);
    const width = fixedWidth(opts.valueType) ?? opts.byteLength ?? bytes.length;
    if (bytes.length < width) return partial(kind, hex, width);
    const slice = bytes.subarray(0, width);
    const endian = opts.endianness;
    const base = opts.displayBase;

    switch (opts.valueType) {
        case "int8":
        case "int16":
        case "int32":
        case "int64": {
            const v = readInt(slice, width, true, endian);
            return { ok: true, kind: "int", bytesHex: bytesToHex(slice), byteLength: width, int: v, display: formatInt(v, width, base) };
        }
        case "uint8":
        case "uint16":
        case "uint32":
        case "uint64": {
            const v = readInt(slice, width, false, endian);
            return { ok: true, kind: "uint", bytesHex: bytesToHex(slice), byteLength: width, int: v, display: formatInt(v, width, base) };
        }
        case "pointer": {
            const v = readInt(slice, 8, false, endian);
            const display = base === "decimal" ? v.toString() : "0x" + v.toString(16);
            return { ok: true, kind: "pointer", bytesHex: bytesToHex(slice), byteLength: 8, int: v, display };
        }
        case "bool": {
            const b = slice[0] !== 0;
            return { ok: true, kind: "bool", bytesHex: bytesToHex(slice), byteLength: 1, bool: b, display: b ? "true" : "false" };
        }
        case "float32":
        case "float64": {
            const dv = new DataView(slice.buffer, slice.byteOffset, width);
            const n = opts.valueType === "float32" ? dv.getFloat32(0, endian === "little") : dv.getFloat64(0, endian === "little");
            return { ok: true, kind: "float", bytesHex: bytesToHex(slice), byteLength: width, float: n, display: formatFloat(n) };
        }
        case "bytes": {
            const h = bytesToHex(slice);
            return { ok: true, kind: "bytes", bytesHex: h, byteLength: width, text: h, display: h };
        }
        default: {
            // ascii / utf8 / utf16*
            const { text, error } = decodeString(slice, opts.valueType);
            const display = base === "hex" ? bytesToHex(slice) : JSON.stringify(text);
            return { ok: error === undefined, kind: "string", bytesHex: bytesToHex(slice), byteLength: width, text, display, error };
        }
    }
}

export function decodeForWatch(hex: string, def: Pick<MemoryWatchDefinition, "valueType" | "endianness" | "byteLength" | "displayBase">): DecodedWatchValue {
    return decodeWatchValue(hex, {
        valueType: def.valueType,
        endianness: def.endianness,
        byteLength: def.byteLength,
        displayBase: def.displayBase,
    });
}

// Re-format an already-decoded value under a different display base WITHOUT re-reading memory — a
// display change must never count as a memory-value change.
export function reformat(dec: DecodedWatchValue, valueType: WatchValueType, base: WatchDisplayBase): string {
    if (!dec.ok) return dec.display;
    if (dec.int !== undefined) {
        const width = dec.byteLength;
        if (valueType === "pointer") return base === "decimal" ? dec.int.toString() : "0x" + dec.int.toString(16);
        return formatInt(dec.int, width, base);
    }
    if (dec.float !== undefined) return formatFloat(dec.float);
    if (dec.bool !== undefined) return dec.bool ? "true" : "false";
    if (isStringType(valueType)) return base === "hex" ? dec.bytesHex : JSON.stringify(dec.text ?? "");
    return dec.display;
}
