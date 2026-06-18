// Pure formatting/decoding helpers for the memory viewer. No Solid, no protocol - just
// bytes in, display strings out. Kept separate from the type registry so both the registry
// and the row components can share them.

/** Decode the agent's lowercase hex byte string ("00ff…") into a Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

/** Space out an already-hex string into byte pairs, e.g. "488b0d" -> "48 8b 0d". Used for the
 *  agent's hex strings (a pointer's peeked target bytes) that are already decoded. */
export function hexPairs(hex: string): string {
    return hex.match(/../g)?.join(" ") ?? "";
}

/** `len` bytes at `offset` as space-separated pairs, e.g. "48 8B 0D 9C". */
export function bytePairs(view: DataView, offset: number, len: number, upper = true): string {
    const parts: string[] = [];
    for (let i = 0; i < len && offset + i < view.byteLength; i++) {
        const h = view.getUint8(offset + i).toString(16).padStart(2, "0");
        parts.push(upper ? h.toUpperCase() : h);
    }
    return parts.join(" ");
}

/** ASCII rendering of the bytes, non-printable shown as '.', like a hex editor. */
export function asciiPreview(view: DataView, offset: number, len: number): string {
    let out = "";
    for (let i = 0; i < len && offset + i < view.byteLength; i++) {
        const c = view.getUint8(offset + i);
        out += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ".";
    }
    return out;
}

/** Decode a string from `byteLen` bytes at `offset`, stopping at the first NUL terminator.
 *  `wide` reads UTF-16LE (2 bytes/char); non-printable code points render as '.'. */
export function readString(view: DataView, offset: number, byteLen: number, wide: boolean): string {
    const step = wide ? 2 : 1;
    let out = "";
    for (let i = 0; i + step <= byteLen && offset + i + step <= view.byteLength; i += step) {
        const c = wide ? view.getUint16(offset + i, true) : view.getUint8(offset + i);
        if (c === 0) break;
        out += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ".";
    }
    return out;
}

/** Trim a float to at most `decimals` places, dropping trailing zeros (1.5000 -> "1.5"). */
export function formatFloat(value: number, decimals = 4): string {
    if (!Number.isFinite(value)) return String(value);
    return parseFloat(value.toFixed(decimals)).toString();
}

/** Signed decimal plus unsigned hex, e.g. "100 (0x64)" - matches the classic view. */
export function formatInt(value: number | bigint, unsignedHex: string): string {
    return `${value.toString()} (0x${unsignedHex})`;
}

export interface DiffSegment {
    text: string;
    changed: boolean;
}

// Split `cur` against the previous tick's value so only the characters that actually moved
// get highlighted (the changing fractional digits of a float, the low bytes of a counter).
// Equal or first-seen values produce a single unchanged segment.
export function diffSegments(prev: string | undefined, cur: string): DiffSegment[] {
    if (prev === undefined || prev === cur) return [{ text: cur, changed: false }];

    let head = 0;
    while (head < prev.length && head < cur.length && prev[head] === cur[head]) head++;

    let tail = 0;
    while (
        tail < prev.length - head &&
        tail < cur.length - head &&
        prev[prev.length - 1 - tail] === cur[cur.length - 1 - tail]
    ) {
        tail++;
    }

    const segments: DiffSegment[] = [];
    if (head > 0) segments.push({ text: cur.slice(0, head), changed: false });
    const mid = cur.slice(head, cur.length - tail);
    if (mid) segments.push({ text: mid, changed: true });
    if (tail > 0) segments.push({ text: cur.slice(cur.length - tail), changed: false });
    return segments;
}
