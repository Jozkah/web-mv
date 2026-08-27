import { describe, expect, it } from "vitest";
import { decodeWatchValue, reformat } from "../decode";
import type { WatchValueType, WatchEndianness, WatchDisplayBase } from "../model";

function dec(hex: string, valueType: WatchValueType, byteLength?: number, endianness: WatchEndianness = "little", displayBase: WatchDisplayBase = "auto") {
    return decodeWatchValue(hex, { valueType, endianness, byteLength, displayBase });
}

describe("decodeWatchValue", () => {
    it("decodes little-endian signed/unsigned integers", () => {
        expect(dec("e8030000", "int32").int).toBe(1000n);
        expect(dec("ff", "int8").int).toBe(-1n);
        expect(dec("ff", "uint8").int).toBe(255n);
        expect(dec("fdff", "int16").int).toBe(-3n);
    });

    it("decodes 64-bit integers as BigInt without precision loss", () => {
        expect(dec("ffffffffffffffff", "uint64").int).toBe(18446744073709551615n);
        expect(dec("ffffffffffffffff", "int64").int).toBe(-1n);
        expect(dec("0000000000002000", "uint64").int).toBe(0x0020000000000000n);
    });

    it("honors big-endian byte order", () => {
        expect(dec("000003e8", "uint32", undefined, "big").int).toBe(1000n);
    });

    it("decodes floats including NaN and Infinity", () => {
        expect(dec("0000c03f", "float32").float).toBeCloseTo(1.5, 6);
        expect(Number.isNaN(dec("0000c07f", "float32").float!)).toBe(true);
        expect(dec("0000807f", "float32").float).toBe(Infinity);
        expect(dec("0000c07f", "float32").display).toBe("NaN");
    });

    it("decodes bool and pointer", () => {
        expect(dec("00", "bool").bool).toBe(false);
        expect(dec("01", "bool").bool).toBe(true);
        const p = dec("0010000000000000", "pointer");
        expect(p.int).toBe(0x1000n);
        expect(p.display).toBe("0x1000");
    });

    it("decodes strings with NUL termination and byte length", () => {
        // "Hi\0X" -> "Hi"
        expect(dec("48690058", "ascii", 4).text).toBe("Hi");
        // utf16le "AB"
        expect(dec("41004200", "utf16le", 4).text).toBe("AB");
        // utf16be "AB"
        expect(dec("00410042", "utf16be", 4).text).toBe("AB");
    });

    it("reports partial reads explicitly", () => {
        const d = dec("00", "int32");
        expect(d.ok).toBe(false);
        expect(d.error).toContain("partial");
    });

    it("preserves raw bytes and reformats without re-reading", () => {
        const d = dec("e8030000", "int32");
        expect(d.bytesHex).toBe("e8030000");
        expect(reformat(d, "int32", "hex")).toBe("0x3e8");
        expect(reformat(d, "int32", "binary")).toBe("0b00000000000000000000001111101000");
        expect(reformat(d, "int32", "decimal")).toBe("1000");
    });
});
