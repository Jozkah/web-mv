import { describe, expect, it } from "vitest";
import { num, raw, serializeCsv, text } from "../csv";

// A tiny RFC-4180 parser for round-trip verification (handles quotes, doubled quotes, CRLF, embedded
// newlines). Deliberately minimal — just enough to prove the serializer produces parseable CSV.
function parseCsv(input: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let i = 0;
    let inQuotes = false;
    while (i < input.length) {
        const c = input[i]!;
        if (inQuotes) {
            if (c === '"') {
                if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += c; i++; continue;
        }
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ",") { row.push(field); field = ""; i++; continue; }
        if (c === "\r" && input[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 2; continue; }
        if (c === "\n" || c === "\r") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
        field += c; i++;
    }
    row.push(field);
    rows.push(row);
    return rows;
}

describe("serializeCsv — RFC-4180 quoting", () => {
    it("quotes fields with comma, quote, CR, LF and doubles embedded quotes", () => {
        const out = serializeCsv([[text("a,b"), text('he said "hi"'), text("line1\nline2"), text("c\rd")]]);
        expect(out).toBe('"a,b","he said ""hi""","line1\nline2","c\rd"');
        const parsed = parseCsv(out);
        expect(parsed[0]).toEqual(["a,b", 'he said "hi"', "line1\nline2", "c\rd"]);
    });

    it("leaves simple fields unquoted and keeps empty fields", () => {
        expect(serializeCsv([[text("plain"), text(""), num(5)]])).toBe("plain,,5");
    });

    it("uses CRLF row endings by default, honors a header", () => {
        const out = serializeCsv([[num(1)], [num(2)]], { header: ["n"] });
        expect(out).toBe("n\r\n1\r\n2");
    });

    it("survives unicode intact", () => {
        const out = serializeCsv([[text("café ☕ 日本語")]]);
        expect(parseCsv(out)[0]![0]).toBe("café ☕ 日本語");
    });
});

describe("serializeCsv — numeric cells", () => {
    it("preserves BigInt precision beyond 2^53", () => {
        const big = 0xffffffffffffffffn;
        expect(serializeCsv([[num(big)]])).toBe("18446744073709551615");
    });
    it("does NOT formula-guard a negative number", () => {
        expect(serializeCsv([[num(-42)]])).toBe("-42");
        expect(serializeCsv([[num("-0x1400")]])).toBe("-0x1400"); // pre-formatted numeric token, untouched
    });
    it("uses documented forms for NaN/Infinity", () => {
        expect(serializeCsv([[num(NaN), num(Infinity), num(-Infinity)]])).toBe("NaN,Infinity,-Infinity");
    });
    it("never emits undefined or [object Object]", () => {
        const out = serializeCsv([[num(0), text(""), raw("")]]);
        expect(out).not.toContain("undefined");
        expect(out).not.toContain("[object");
    });
});

describe("serializeCsv — spreadsheet formula safety", () => {
    it("prefixes a formula-marker text cell with a quote", () => {
        for (const s of ["=SUM(A1)", "+1+1", "-cmd", "@import", "\t=x", "\r=x"]) {
            const cell = serializeCsv([[text(s)]]);
            const parsed = parseCsv(cell)[0]![0]!;
            expect(parsed.startsWith("'")).toBe(true);
        }
    });
    it("guards a marker that follows leading spaces", () => {
        expect(parseCsv(serializeCsv([[text("   =evil()")]]))[0]![0]).toBe("'   =evil()");
    });
    it("does not touch ordinary text or raw canonical addresses", () => {
        expect(serializeCsv([[text("hello"), raw("0x140001000"), raw("-")]])).toBe("hello,0x140001000,-");
    });
});

describe("serializeCsv — determinism & round trip", () => {
    it("is deterministic and round-trips a mixed table", () => {
        const rows = [
            [num(1), raw("0x1000"), text("val,\"x\"")],
            [num(2), raw("0x2000"), text("=danger")],
        ];
        const a = serializeCsv(rows, { header: ["seq", "addr", "value"] });
        const b = serializeCsv(rows, { header: ["seq", "addr", "value"] });
        expect(a).toBe(b);
        const parsed = parseCsv(a);
        expect(parsed[0]).toEqual(["seq", "addr", "value"]);
        expect(parsed[1]).toEqual(["1", "0x1000", 'val,"x"']);
        expect(parsed[2]![2]).toBe("'=danger");
    });
});
