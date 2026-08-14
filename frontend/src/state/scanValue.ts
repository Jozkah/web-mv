import type { ScanValueType } from "../protocol/types";

// Encode a user-entered value into the raw little-endian bits the agent's read_uint32/read_uint64
// will observe, as a hex number string ("0x64" for int 100, "0x41480000" for float 12.5). This is
// the value the scanner compares against - byte order is handled by writing little-endian and
// reading the same width back, so the agent never has to know about endianness.

export const SCAN_TYPES: { key: ScanValueType; label: string }[] = [
    { key: "i32", label: "int32" },
    { key: "u32", label: "uint32" },
    { key: "f32", label: "float" },
    { key: "i64", label: "int64" },
    { key: "u64", label: "uint64" },
];

function scanWidth(type: ScanValueType): number {
    return type === "i64" || type === "u64" ? 8 : 4;
}

export function valueToBits(input: string, type: ScanValueType): string | undefined {
    const raw = input.trim();
    if (raw === "") return undefined;
    const width = scanWidth(type);
    const bytes = new Uint8Array(width);
    const view = new DataView(bytes.buffer);
    try {
        if (type === "f32") {
            const f = Number(raw);
            if (!Number.isFinite(f)) return undefined;
            view.setFloat32(0, f, true);
        } else {
            const bits = BigInt(width * 8);
            const span = 1n << bits;
            const wrapped = ((BigInt(raw) % span) + span) % span; // two's complement for negatives
            for (let i = 0; i < width; i++) bytes[i] = Number((wrapped >> BigInt(i * 8)) & 0xffn);
        }
    } catch {
        return undefined;
    }
    const value = width === 8 ? view.getBigUint64(0, true) : BigInt(view.getUint32(0, true));
    return "0x" + value.toString(16);
}
