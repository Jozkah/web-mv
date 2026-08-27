// One pure RFC-4180 CSV serializer for every CSV export. It replaces ad-hoc `JSON.stringify`/manual
// quoting, which produced invalid CSV (backslash-escaped quotes) and left user-controlled text open to
// spreadsheet formula injection.
//
// Two cell classes, chosen by the CALLER from schema knowledge — never guessed here:
//   - text()   user-controlled text (watch names, notes, tags, target strings, packet info). Gets
//              RFC-4180 quoting AND a spreadsheet-formula guard.
//   - num()    a numeric/boolean/canonical value that must NOT be formula-guarded (a negative number
//              stays a negative number). BigInt is preserved exactly; NaN/Infinity get documented forms.
//   - raw()    an already-safe canonical token (a hex address, an ISO timestamp). RFC-4180 quoted if
//              needed, but never formula-guarded (these never begin with a formula marker).
//
// RFC-4180: a field is quoted iff it contains a comma, double-quote, CR, or LF; embedded double-quotes
// are doubled. Rows end with CRLF by default (RFC-4180). Output is deterministic.

export type CsvCell =
    | { readonly t: "text"; readonly v: string }
    | { readonly t: "num"; readonly v: number | bigint | string }
    | { readonly t: "raw"; readonly v: string };

export const text = (v: string): CsvCell => ({ t: "text", v });
export const num = (v: number | bigint | string): CsvCell => ({ t: "num", v });
export const raw = (v: string): CsvCell => ({ t: "raw", v });

// Formula-injection markers: a text cell whose first non-whitespace char is one of these could be
// interpreted as a formula by Excel/Sheets. We prefix a single quote (the standard text marker) so the
// cell is shown literally. Numeric cells are never passed through here, so a real negative number
// (a `num` cell) is untouched.
const FORMULA_MARKERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

function guardFormula(s: string): string {
    // First non-whitespace character (space/tab). Leading whitespace + a marker is still dangerous.
    let i = 0;
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
    const first = s[i];
    return first !== undefined && FORMULA_MARKERS.has(first) ? `'${s}` : s;
}

function rfc4180(field: string): string {
    return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function numericString(v: number | bigint | string): string {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string") return v; // caller pre-formatted (canonical); trusted numeric-ish token
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return String(v);
}

function encodeCell(cell: CsvCell): string {
    switch (cell.t) {
        case "text":
            return rfc4180(guardFormula(cell.v));
        case "num":
            return rfc4180(numericString(cell.v));
        case "raw":
            return rfc4180(cell.v);
    }
}

export interface CsvOptions {
    eol?: string; // default CRLF per RFC-4180
    header?: string[]; // optional header row (treated as raw)
}

export function serializeCsv(rows: CsvCell[][], opts: CsvOptions = {}): string {
    const eol = opts.eol ?? "\r\n";
    const lines: string[] = [];
    if (opts.header) lines.push(opts.header.map((h) => rfc4180(h)).join(","));
    for (const row of rows) lines.push(row.map(encodeCell).join(","));
    return lines.join(eol);
}
