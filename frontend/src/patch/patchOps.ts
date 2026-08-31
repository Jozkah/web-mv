// Pure byte operations for the patch workspace: hex parsing/formatting, NOP-fill, overlap/conflict
// detection, and byte diffs. No assembler exists (Zydis disassembles only), so patches are always
// explicit bytes — never assembled from text. Original bytes are always retained so a patch is
// reversible. Deterministic and unit-testable.

export function normalizeHex(input: string): string | undefined {
    const clean = input.replace(/^0x/i, "").replace(/[\s,]/g, "").toLowerCase();
    if (clean.length === 0 || clean.length % 2 !== 0) return undefined;
    if (!/^[0-9a-f]+$/.test(clean)) return undefined;
    return clean;
}

export function hexLen(hex: string): number {
    return (normalizeHex(hex)?.length ?? 0) >> 1;
}

// A NOP sled of `len` bytes (x86 0x90). Used for "NOP fill" over a known length.
export function nopFill(len: number): string {
    if (len <= 0) return "";
    return "90".repeat(len);
}

export interface ByteDiff {
    offset: number;
    before: string; // 2-hex
    after: string; // 2-hex
}

// Per-byte differences between two equal-length hex strings (padding the shorter with the longer's
// bytes is NOT done — callers must supply equal lengths, which the patch model enforces).
export function byteDiff(before: string, after: string): ByteDiff[] {
    const a = normalizeHex(before) ?? "";
    const b = normalizeHex(after) ?? "";
    const n = Math.min(a.length, b.length) >> 1;
    const out: ByteDiff[] = [];
    for (let i = 0; i < n; i++) {
        const x = a.slice(i * 2, i * 2 + 2);
        const y = b.slice(i * 2, i * 2 + 2);
        if (x !== y) out.push({ offset: i, before: x, after: y });
    }
    return out;
}

export interface Range {
    id: string;
    start: bigint; // absolute address
    length: number;
}

// Two ranges conflict when they overlap. Returns pairs of conflicting ids.
export function findConflicts(ranges: readonly Range[]): [string, string][] {
    const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const out: [string, string][] = [];
    for (let i = 0; i < sorted.length; i++) {
        const a = sorted[i];
        const aEnd = a.start + BigInt(a.length);
        for (let j = i + 1; j < sorted.length; j++) {
            const b = sorted[j];
            if (b.start >= aEnd) break; // sorted: no later range can overlap `a`
            out.push([a.id, b.id]);
        }
    }
    return out;
}

// The set of range ids that overlap at least one other range.
export function conflictingIds(ranges: readonly Range[]): Set<string> {
    const s = new Set<string>();
    for (const [a, b] of findConflicts(ranges)) {
        s.add(a);
        s.add(b);
    }
    return s;
}
