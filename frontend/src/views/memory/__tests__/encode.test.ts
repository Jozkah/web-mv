import { describe, expect, it } from "vitest";
import { editText, encodeValue, isEditableType, parseIntText } from "../nodes/encode";
import type { Node } from "../nodes/types";

// Every typed value encoder and its validation boundaries: widths, signedness, endianness,
// string capacity, numeric bounds, malformed input. The hex output is the agent wire format
// (lowercase little-endian byte pairs) that goes straight into a write request.

const node = (typeId: Node["typeId"], extra?: Partial<Node>): Node => ({
    id: "t",
    typeId,
    ...extra,
});

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe("parseIntText", () => {
    it("parses decimal, hex, and binary", () => {
        expect(parseIntText("42")).toBe(42n);
        expect(parseIntText("-42")).toBe(-42n);
        expect(parseIntText("0x2a")).toBe(42n);
        expect(parseIntText("0X2A")).toBe(42n);
        expect(parseIntText("0b101")).toBe(5n);
        expect(parseIntText("-0x10")).toBe(-16n);
    });
    it("rejects malformed input", () => {
        expect(parseIntText("")).toBeUndefined();
        expect(parseIntText("abc")).toBeUndefined();
        expect(parseIntText("1.5")).toBeUndefined();
        expect(parseIntText("0x")).toBeUndefined();
        expect(parseIntText("1e3")).toBeUndefined();
    });
});

describe("integer encoding", () => {
    it("encodes little-endian by width", () => {
        expect(encodeValue(node("int8"), "-1")).toEqual({ ok: true, hex: "ff" });
        expect(encodeValue(node("uint16"), "0x1234")).toEqual({ ok: true, hex: "3412" });
        expect(encodeValue(node("int32"), "1")).toEqual({ ok: true, hex: "01000000" });
        expect(encodeValue(node("uint64"), "0x1122334455667788")).toEqual({
            ok: true,
            hex: "8877665544332211",
        });
    });

    it("encodes big-endian when the node carries the override", () => {
        expect(encodeValue(node("uint16", { endian: "be" }), "0x1234")).toEqual({ ok: true, hex: "1234" });
        expect(encodeValue(node("int32", { endian: "be" }), "1")).toEqual({ ok: true, hex: "00000001" });
    });

    it("range-checks signed bounds", () => {
        expect(encodeValue(node("int8"), "127").ok).toBe(true);
        expect(encodeValue(node("int8"), "128").ok).toBe(false);
        expect(encodeValue(node("int8"), "-128").ok).toBe(true);
        expect(encodeValue(node("int8"), "-129").ok).toBe(false);
        expect(encodeValue(node("int16"), "32768").ok).toBe(false);
        expect(encodeValue(node("int64"), "9223372036854775807").ok).toBe(true);
        expect(encodeValue(node("int64"), "9223372036854775808").ok).toBe(false);
    });

    it("range-checks unsigned bounds", () => {
        expect(encodeValue(node("uint8"), "255").ok).toBe(true);
        expect(encodeValue(node("uint8"), "256").ok).toBe(false);
        expect(encodeValue(node("uint8"), "-1").ok).toBe(false);
        expect(encodeValue(node("uint64"), "18446744073709551615").ok).toBe(true);
        expect(encodeValue(node("uint64"), "18446744073709551616").ok).toBe(false);
    });

    it("reports a specific message on overflow", () => {
        const r = encodeValue(node("int16"), "99999");
        expect(r).toMatchObject({ ok: false });
        if (!r.ok) expect(r.error).toContain("int16");
    });

    it("rejects malformed numbers", () => {
        expect(encodeValue(node("int32"), "twelve").ok).toBe(false);
        expect(encodeValue(node("int32"), "").ok).toBe(false);
    });

    it("two's-complement round-trips negatives", () => {
        expect(encodeValue(node("int16"), "-2")).toEqual({ ok: true, hex: "feff" });
        expect(encodeValue(node("int64"), "-1")).toEqual({ ok: true, hex: "ffffffffffffffff" });
    });
});

describe("float encoding", () => {
    it("encodes float and double little-endian", () => {
        expect(encodeValue(node("float"), "1")).toEqual({ ok: true, hex: "0000803f" });
        expect(encodeValue(node("double"), "1")).toEqual({ ok: true, hex: "000000000000f03f" });
        expect(encodeValue(node("float"), "-1.5")).toEqual({ ok: true, hex: "0000c0bf" });
    });
    it("supports big-endian floats", () => {
        expect(encodeValue(node("float", { endian: "be" }), "1")).toEqual({ ok: true, hex: "3f800000" });
    });
    it("rejects malformed and out-of-range floats", () => {
        expect(encodeValue(node("float"), "abc").ok).toBe(false);
        expect(encodeValue(node("float"), "1e39").ok).toBe(false);
        expect(encodeValue(node("double"), "1e39").ok).toBe(true);
        expect(encodeValue(node("float"), "0x40").ok).toBe(false);
    });
});

describe("bool encoding", () => {
    it("accepts true/false/1/0", () => {
        expect(encodeValue(node("bool"), "true")).toEqual({ ok: true, hex: "01" });
        expect(encodeValue(node("bool"), "FALSE")).toEqual({ ok: true, hex: "00" });
        expect(encodeValue(node("bool"), "1")).toEqual({ ok: true, hex: "01" });
        expect(encodeValue(node("bool"), "0")).toEqual({ ok: true, hex: "00" });
    });
    it("rejects anything else", () => {
        expect(encodeValue(node("bool"), "yes").ok).toBe(false);
        expect(encodeValue(node("bool"), "2").ok).toBe(false);
    });
});

describe("pointer encoding", () => {
    it("encodes 8-byte little-endian addresses, with or without 0x", () => {
        expect(encodeValue(node("pointer"), "0x1000")).toEqual({ ok: true, hex: "0010000000000000" });
        expect(encodeValue(node("pointer"), "deadbeef")).toEqual({ ok: true, hex: "efbeadde00000000" });
        expect(encodeValue(node("funcptr"), "0x7ff612345678")).toEqual({ ok: true, hex: "78563412f67f0000" });
    });
    it("rejects non-hex and oversized addresses", () => {
        expect(encodeValue(node("pointer"), "hello!").ok).toBe(false);
        expect(encodeValue(node("pointer"), "0x11223344556677889").ok).toBe(false);
        expect(encodeValue(node("pointer"), "").ok).toBe(false);
    });
});

describe("string encoding", () => {
    it("NUL-pads ASCII to the field capacity", () => {
        expect(encodeValue(node("string", { length: 4 }), "AB")).toEqual({ ok: true, hex: "41420000" });
        expect(encodeValue(node("string", { length: 2 }), "AB")).toEqual({ ok: true, hex: "4142" });
    });
    it("rejects overflow and non-ASCII", () => {
        expect(encodeValue(node("string", { length: 2 }), "ABC").ok).toBe(false);
        expect(encodeValue(node("string", { length: 8 }), "héllo").ok).toBe(false);
    });
    it("encodes UTF-16LE with capacity in bytes", () => {
        expect(encodeValue(node("wstring", { length: 6 }), "AB")).toEqual({ ok: true, hex: "410042000000" });
        expect(encodeValue(node("wstring", { length: 2 }), "AB").ok).toBe(false);
        expect(encodeValue(node("wstring", { length: 4 }), "é")).toEqual({ ok: true, hex: "e9000000" });
    });
});

describe("bitfield encoding", () => {
    it("accepts binary, decimal, and hex", () => {
        expect(encodeValue(node("bits8"), "0b1010")).toEqual({ ok: true, hex: "0a" });
        expect(encodeValue(node("bits8"), "10")).toEqual({ ok: true, hex: "0a" });
        expect(encodeValue(node("bits16"), "0xff00")).toEqual({ ok: true, hex: "00ff" });
    });
    it("enforces unsigned width bounds", () => {
        expect(encodeValue(node("bits8"), "256").ok).toBe(false);
        expect(encodeValue(node("bits8"), "-1").ok).toBe(false);
    });
});

describe("vector and matrix encoding", () => {
    it("encodes N comma/space separated floats", () => {
        expect(encodeValue(node("vec2"), "1, 0")).toEqual({ ok: true, hex: "0000803f00000000" });
        expect(encodeValue(node("vec3"), "0 0 1").ok).toBe(true);
        const m = encodeValue(node("mat4"), Array(16).fill("0").join(","));
        expect(m.ok).toBe(true);
        if (m.ok) expect(m.hex.length).toBe(128);
    });
    it("rejects wrong arity and bad numbers", () => {
        expect(encodeValue(node("vec2"), "1").ok).toBe(false);
        expect(encodeValue(node("vec2"), "1,2,3").ok).toBe(false);
        expect(encodeValue(node("vec2"), "1,x").ok).toBe(false);
    });
});

describe("enumref encoding", () => {
    const refs = { enumValue: (e: string, m: string) => (e === "Team" && m === "RED" ? 2 : undefined) };
    it("resolves member names through the registry", () => {
        expect(encodeValue(node("enumref", { refName: "Team", length: 4 }), "RED", refs)).toEqual({
            ok: true,
            hex: "02000000",
        });
    });
    it("falls back to integers, honoring the captured width", () => {
        expect(encodeValue(node("enumref", { refName: "Team", length: 1 }), "5", refs)).toEqual({ ok: true, hex: "05" });
        expect(encodeValue(node("enumref", { refName: "Team", length: 1 }), "999", refs).ok).toBe(false);
    });
});

describe("non-editable types", () => {
    it("fills, unions, and struct refs are not editable", () => {
        expect(isEditableType(node("fill8"))).toBe(false);
        expect(isEditableType(node("union4"))).toBe(false);
        expect(isEditableType(node("structref", { refName: "S", length: 8 }))).toBe(false);
        expect(isEditableType(node("int32"))).toBe(true);
        expect(isEditableType(node("mat4"))).toBe(true);
    });
    it("encodeValue refuses them with a message", () => {
        expect(encodeValue(node("structref", { refName: "S", length: 8 }), "1").ok).toBe(false);
        expect(encodeValue(node("fill4"), "1").ok).toBe(false);
    });
});

describe("editText prefill", () => {
    it("round-trips through encodeValue for common types", () => {
        const v = view(0xfe, 0xff, 0x00, 0x00); // int16 -2 at offset 0
        const n16 = node("int16");
        const text = editText(n16, v, 0);
        expect(text).toBe("-2");
        expect(encodeValue(n16, text)).toEqual({ ok: true, hex: "feff" });
    });
    it("prefills strings without display placeholders", () => {
        const v = view(0x48, 0x69, 0x00, 0x00);
        expect(editText(node("string", { length: 4 }), v, 0)).toBe("Hi");
    });
    it("prefills pointers as hex", () => {
        const v = view(0x00, 0x10, 0, 0, 0, 0, 0, 0);
        expect(editText(node("pointer"), v, 0)).toBe("0x1000");
    });
    it("returns empty when out of bounds", () => {
        expect(editText(node("int32"), view(1, 2), 0)).toBe("");
    });
});
