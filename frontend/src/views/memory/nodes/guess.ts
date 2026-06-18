import { offsets } from "./layout";
import { isFill, nodeSize, type GuessField, type Node, type NodeTypeId } from "./types";

// ReClass-style type guessing. We classify every untyped tile from the live bytes with a set
// of strict-but-opinionated rules: confident where we can verify (a pointer is committed only
// when its target is in the x64 user-mode range AND the agent can actually read it), and
// willing to guess where we can't - a plausible float/int/string label is more useful than
// leaving a field blank, so we accept the occasional miss on purpose. Guesses only ever
// upgrade untyped tiles, never a hand-typed field, and always re-tile the exact same byte
// span so no later offset shifts.

// x64 canonical user-mode addresses: above the 64K null region, below the 0x7FFF... ceiling.
export const USERMODE_MIN = 0x10000n;
export const USERMODE_MAX = 0x7fffffffffffn;

export function isUsermodePointer(value: bigint): boolean {
    return value >= USERMODE_MIN && value <= USERMODE_MAX;
}

// Magnitude bands where real game data lives. A reinterpreted small integer lands far outside
// these (as an absurd denormal or a huge value), so int vs float separates cleanly most of
// the time; doubles get a wider band since they carry far more range.
const FLOAT_MIN = 1e-4;
const FLOAT_MAX = 1e9;
const DOUBLE_MIN = 1e-6;
const DOUBLE_MAX = 1e12;

function popcount32(n: number): number {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// A 32-bit pattern reads as a "real" float when its exponent field is normal (not zero/
// denormal, not inf/NaN), its magnitude is in the band above, AND it carries enough set bits
// to be a computed value rather than a flag, mask, or round power of two. That popcount guard
// is what rejects ints like 0x40000000 (which decodes to 2.0f but has a single set bit) while
// keeping genuine constants such as 1.0/0.5/100.0, whose mantissas are bit-rich (popcount >= 6).
function looksLikeFloat(bits: number, value: number): boolean {
    const exp = (bits >>> 23) & 0xff;
    if (exp === 0 || exp === 0xff) return false;
    const m = Math.abs(value);
    if (m < FLOAT_MIN || m > FLOAT_MAX) return false;
    return popcount32(bits) > 2;
}

// Same idea for a 64-bit double: the 11-bit exponent (bits 20..30 of the high word) must be
// normal, the magnitude in-band, and the 52-bit mantissa must carry real bits rather than be a
// round constant. Used only when the qword doesn't split into two plausible floats (a vec2).
function looksLikeDouble(hi: number, lo: number, value: number): boolean {
    const exp = (hi >>> 20) & 0x7ff;
    if (exp === 0 || exp === 0x7ff) return false;
    const m = Math.abs(value);
    if (m < DOUBLE_MIN || m > DOUBLE_MAX) return false;
    return popcount32(hi & 0xfffff) + popcount32(lo) > 2;
}

// A high-bit-set integer below this magnitude reads more naturally as a small signed value
// (-1, -100, a negative handle) than as a huge unsigned one; above it we call it unsigned.
const SMALL_NEGATIVE = -0x1000000; // -16M

function guessDword(view: DataView, o: number): NodeTypeId {
    const bits = view.getUint32(o, true);
    if (looksLikeFloat(bits, view.getFloat32(o, true))) return "float";
    if (bits <= 0x7fffffff) return "int32";
    return view.getInt32(o, true) >= SMALL_NEGATIVE ? "int32" : "uint32";
}

function guessWord(view: DataView, o: number): NodeTypeId {
    if (view.getUint16(o, true) <= 0x7fff) return "int16";
    return view.getInt16(o, true) >= -0x1000 ? "int16" : "uint16";
}

function guessByte(view: DataView, o: number): NodeTypeId {
    const u = view.getUint8(o);
    if (u === 0 || u === 1) return "bool";
    return u <= 0x7f ? "int8" : "uint8";
}

// An 8-byte slot that is neither a pointer nor a string. All-zero is ambiguous padding (left
// untyped). A genuine double or a small 64-bit signed integer is kept whole; otherwise we read
// it as two dwords so a float/int pair (vec2-ish data) is captured rather than swallowed into
// one 64-bit field we'd usually guess wrong.
function guessQword(view: DataView, o: number): NodeTypeId[] {
    if (view.getBigUint64(o, true) === 0n) return [];

    const lo = view.getUint32(o, true);
    const hi = view.getUint32(o + 4, true);

    // All-ones high word with the low word's sign bit set reads as a small negative int64
    // (e.g. -1), not two unrelated dwords.
    if (hi === 0xffffffff && (lo & 0x80000000) !== 0) return ["int64"];

    const loIsFloat = looksLikeFloat(lo, view.getFloat32(o, true));
    const hiIsFloat = looksLikeFloat(hi, view.getFloat32(o + 4, true));
    if (!(loIsFloat && hiIsFloat) && looksLikeDouble(hi, lo, view.getFloat64(o, true))) {
        return ["double"];
    }

    return [guessDword(view, o), guessDword(view, o + 4)];
}

// --- string detection -------------------------------------------------------------------

const MIN_ASCII = 5; // printable chars in a row, NUL-terminated, to call it text
const MIN_UTF16 = 3; // printable wide pairs (char, 0x00) in a row, 0x0000-terminated

function isPrintable(c: number): boolean {
    return c >= 0x20 && c <= 0x7e;
}

// Tag every byte of the region as part of an ASCII run (1) or a UTF-16LE run (2). Detection
// is deliberately conservative: we only tag a run that is both long enough AND NUL-terminated.
// The terminator is the decisive signal - a real C/C++ string ends in a 0 byte, whereas a
// chance run of printable bytes inside numeric or pointer data is followed by arbitrary bytes
// and so is rejected. UTF-16 is matched first ("A\0B\0..." pairs) so it isn't mistaken for a
// series of one-char ASCII runs; ASCII then claims any remaining printable runs. Tags are
// region-wide, so a string spanning several fill tiles is recognised as one run and each
// covered tile retyped to a string. A run reaching the region edge is accepted (its terminator
// would lie just past the read window).
function buildStringTags(view: DataView): Uint8Array {
    const len = view.byteLength;
    const tag = new Uint8Array(len);

    let i = 0;
    while (i + 1 < len) {
        if (isPrintable(view.getUint8(i)) && view.getUint8(i + 1) === 0) {
            let j = i;
            let count = 0;
            while (j + 1 < len && isPrintable(view.getUint8(j)) && view.getUint8(j + 1) === 0) {
                j += 2;
                count++;
            }
            const terminated = j + 1 >= len || (view.getUint8(j) === 0 && view.getUint8(j + 1) === 0);
            if (count >= MIN_UTF16 && terminated) for (let k = i; k < j; k++) tag[k] = 2;
            i = j > i ? j : i + 1;
        } else {
            i++;
        }
    }

    i = 0;
    while (i < len) {
        if (tag[i] === 0 && isPrintable(view.getUint8(i))) {
            let j = i;
            while (j < len && tag[j] === 0 && isPrintable(view.getUint8(j))) j++;
            const terminated = j >= len || view.getUint8(j) === 0;
            if (j - i >= MIN_ASCII && terminated) for (let k = i; k < j; k++) tag[k] = 1;
            i = j;
        } else {
            i++;
        }
    }

    return tag;
}

// Classify a fill tile against the string tags: "ascii" / "utf16" only when every byte is
// either part of that run or a 0x00 terminator/pad (no foreign data mixed in), so the whole
// tile cleanly becomes a char array of the same byte length.
function stringTile(tag: Uint8Array, view: DataView, o: number, size: number): "ascii" | "utf16" | null {
    let hasAscii = false;
    let hasUtf16 = false;
    for (let k = o; k < o + size; k++) {
        if (tag[k] === 1) hasAscii = true;
        else if (tag[k] === 2) hasUtf16 = true;
        else if (view.getUint8(k) !== 0) return null;
    }
    if (hasUtf16 && !hasAscii && size % 2 === 0) return "utf16";
    if (hasAscii && !hasUtf16) return "ascii";
    return null;
}

export interface GuessPlan {
    nodeId: string;
    pointerTarget?: string; // set when the qword is a user-mode address pending a follow-check
    types: GuessField[]; // applied when the slot is not a confirmed pointer ([] = leave untyped)
}

/** Plan a guess for every untyped tile from the live bytes; pointers still need a follow-check. */
export function planGuesses(nodes: readonly Node[], view: DataView): GuessPlan[] {
    const offs = offsets(nodes);
    const tag = buildStringTags(view);
    const out: GuessPlan[] = [];

    nodes.forEach((node, i) => {
        const o = offs[i];
        const size = nodeSize(node.typeId);
        if (!isFill(node.typeId) || o + size > view.byteLength) return;

        // Pointer candidates win over everything else - the verified path must not be lost to a
        // stray printable byte - and carry their two-dword numeric fallback for a failed follow.
        if (node.typeId === "fill8") {
            const q = view.getBigUint64(o, true);
            if (isUsermodePointer(q)) {
                out.push({ nodeId: node.id, pointerTarget: `0x${q.toString(16)}`, types: guessQword(view, o) });
                return;
            }
        }

        const str = stringTile(tag, view, o, size);
        if (str === "ascii") {
            out.push({ nodeId: node.id, types: [{ typeId: "string", length: size }] });
            return;
        }
        if (str === "utf16") {
            out.push({ nodeId: node.id, types: [{ typeId: "wstring", length: size }] });
            return;
        }

        if (node.typeId === "fill8") {
            const types = guessQword(view, o);
            if (types.length > 0) out.push({ nodeId: node.id, types });
            return;
        }

        const types =
            node.typeId === "fill4" ? [guessDword(view, o)]
            : node.typeId === "fill2" ? [guessWord(view, o)]
            : [guessByte(view, o)];
        out.push({ nodeId: node.id, types });
    });

    return out;
}
