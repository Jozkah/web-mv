import { offsets } from "./layout";
import { isFill, nodeSize, type GuessField, type Node } from "./types";

// ReClass-style type guessing. We classify every untyped tile from the live bytes with a set
// of strict-but-opinionated rules: confident where we can verify (a pointer is committed only
// when its target is in the x64 user-mode range AND the agent can actually read it), and
// willing to guess where we can't - a plausible float/int/string label is more useful than
// leaving a field blank, so we accept the occasional miss on purpose. Guesses only ever
// upgrade untyped tiles, never a hand-typed field, and always re-tile the exact same byte
// span so no later offset shifts.
//
// Every guess carries a confidence tier + a short reason. The automatic path applies only
// "high" (verified pointers, terminated strings); "medium"/"low" become reviewable
// suggestions. The classification rules themselves are unchanged from the original guesser -
// confidence is layered on top, never loosening the pointer follow-check.

// x64 canonical user-mode addresses: above the 64K null region, below the 0x7FFF... ceiling.
export const USERMODE_MIN = 0x10000n;
export const USERMODE_MAX = 0x7fffffffffffn;

export function isUsermodePointer(value: bigint): boolean {
    return value >= USERMODE_MIN && value <= USERMODE_MAX;
}

export type Confidence = "high" | "medium" | "low";

/** One classified tile: the replacement fields plus how sure we are and why. */
export interface TypedGuess {
    types: GuessField[];
    confidence: Confidence;
    reason: string;
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

function classifyDword(view: DataView, o: number): TypedGuess {
    const bits = view.getUint32(o, true);
    const f = view.getFloat32(o, true);
    if (looksLikeFloat(bits, f)) {
        return { types: ["float"], confidence: "medium", reason: `decodes to a plausible float (${f.toPrecision(4)})` };
    }
    if (bits <= 0x7fffffff) {
        return { types: ["int32"], confidence: "low", reason: "default integer interpretation" };
    }
    return view.getInt32(o, true) >= SMALL_NEGATIVE
        ? { types: ["int32"], confidence: "low", reason: "small negative value reads as signed" }
        : { types: ["uint32"], confidence: "low", reason: "large high-bit value reads as unsigned" };
}

function classifyWord(view: DataView, o: number): TypedGuess {
    if (view.getUint16(o, true) <= 0x7fff) {
        return { types: ["int16"], confidence: "low", reason: "default integer interpretation" };
    }
    return view.getInt16(o, true) >= -0x1000
        ? { types: ["int16"], confidence: "low", reason: "small negative value reads as signed" }
        : { types: ["uint16"], confidence: "low", reason: "large high-bit value reads as unsigned" };
}

function classifyByte(view: DataView, o: number): TypedGuess {
    const u = view.getUint8(o);
    if (u === 0 || u === 1) {
        return { types: ["bool"], confidence: "medium", reason: `byte is ${u} (bool-like)` };
    }
    return u <= 0x7f
        ? { types: ["int8"], confidence: "low", reason: "default integer interpretation" }
        : { types: ["uint8"], confidence: "low", reason: "high-bit byte reads as unsigned" };
}

// An 8-byte slot that is neither a pointer nor a string. All-zero is ambiguous padding (left
// untyped). A genuine double or a small 64-bit signed integer is kept whole; otherwise we read
// it as two dwords so a float/int pair (vec2-ish data) is captured rather than swallowed into
// one 64-bit field we'd usually guess wrong.
function classifyQword(view: DataView, o: number): TypedGuess {
    if (view.getBigUint64(o, true) === 0n) {
        return { types: [], confidence: "low", reason: "all zero - ambiguous" };
    }

    const lo = view.getUint32(o, true);
    const hi = view.getUint32(o + 4, true);

    // All-ones high word with the low word's sign bit set reads as a small negative int64
    // (e.g. -1), not two unrelated dwords.
    if (hi === 0xffffffff && (lo & 0x80000000) !== 0) {
        return { types: ["int64"], confidence: "medium", reason: "sign-extended small negative int64" };
    }

    const loIsFloat = looksLikeFloat(lo, view.getFloat32(o, true));
    const hiIsFloat = looksLikeFloat(hi, view.getFloat32(o + 4, true));
    if (!(loIsFloat && hiIsFloat) && looksLikeDouble(hi, lo, view.getFloat64(o, true))) {
        return { types: ["double"], confidence: "medium", reason: "decodes to a plausible double" };
    }

    const a = classifyDword(view, o);
    const b = classifyDword(view, o + 4);
    const confidence: Confidence = a.confidence === "medium" && b.confidence === "medium" ? "medium" : "low";
    return { types: [...a.types, ...b.types], confidence, reason: `split as two dwords (${a.reason}; ${b.reason})` };
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

/** Plan a guess for every untyped tile from the live bytes; pointers still need a follow-check.
 *  Locked tiles are never planned. */
export function planGuesses(nodes: readonly Node[], view: DataView): GuessPlan[] {
    return planSuggestions(nodes, view).map((s) => ({
        nodeId: s.nodeId,
        pointerTarget: s.pointerTarget,
        types: s.fields,
    }));
}

/** A reviewable classification for one untyped tile. For a pointer candidate, `fields` holds
 *  the numeric fallback used when the follow-check fails; `finalizeSuggestion` resolves it. */
export interface Suggestion {
    nodeId: string;
    fields: GuessField[];
    confidence: Confidence;
    reason: string;
    pointerTarget?: string;
}

/** Classify every untyped, unlocked tile. Same rules as the original guesser, but each result
 *  carries its confidence + reason for review. */
export function planSuggestions(nodes: readonly Node[], view: DataView): Suggestion[] {
    const offs = offsets(nodes);
    const tag = buildStringTags(view);
    const out: Suggestion[] = [];

    nodes.forEach((node, i) => {
        const o = offs[i];
        const size = nodeSize(node.typeId);
        if (!isFill(node.typeId) || node.locked || o + size > view.byteLength) return;

        // Pointer candidates win over everything else - the verified path must not be lost to a
        // stray printable byte - and carry their two-dword numeric fallback for a failed follow.
        if (node.typeId === "fill8") {
            const q = view.getBigUint64(o, true);
            if (isUsermodePointer(q)) {
                const fallback = classifyQword(view, o);
                out.push({
                    nodeId: node.id,
                    pointerTarget: `0x${q.toString(16)}`,
                    fields: fallback.types,
                    confidence: fallback.confidence,
                    reason: fallback.reason,
                });
                return;
            }
        }

        const str = stringTile(tag, view, o, size);
        if (str === "ascii") {
            out.push({
                nodeId: node.id,
                fields: [{ typeId: "string", length: size }],
                confidence: "high",
                reason: "NUL-terminated printable ASCII run",
            });
            return;
        }
        if (str === "utf16") {
            out.push({
                nodeId: node.id,
                fields: [{ typeId: "wstring", length: size }],
                confidence: "high",
                reason: "NUL-terminated UTF-16LE run",
            });
            return;
        }

        if (node.typeId === "fill8") {
            const g = classifyQword(view, o);
            if (g.types.length > 0) {
                out.push({ nodeId: node.id, fields: g.types, confidence: g.confidence, reason: g.reason });
            }
            return;
        }

        const g =
            node.typeId === "fill4" ? classifyDword(view, o)
            : node.typeId === "fill2" ? classifyWord(view, o)
            : classifyByte(view, o);
        out.push({ nodeId: node.id, fields: g.types, confidence: g.confidence, reason: g.reason });
    });

    return out;
}

/** Resolve a pointer candidate after its follow-check: confirmed targets become a verified
 *  (high-confidence) pointer field; failed ones keep their numeric fallback. Non-pointer
 *  suggestions pass through unchanged. */
export function finalizeSuggestion(s: Suggestion, pointerConfirmed: boolean): Suggestion {
    if (!s.pointerTarget) return s;
    if (pointerConfirmed) {
        return {
            nodeId: s.nodeId,
            fields: ["pointer"],
            confidence: "high",
            reason: `user-mode address ${s.pointerTarget}, target readable`,
        };
    }
    return { nodeId: s.nodeId, fields: s.fields, confidence: s.confidence, reason: `${s.reason} (pointer follow-check failed)` };
}

/** Field-list equality, for accept-time staleness checks (same types and spans, in order). */
export function sameFields(a: GuessField[], b: GuessField[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (typeof x === "string" || typeof y === "string") {
            if (x !== y) return false;
        } else if (x.typeId !== y.typeId || x.length !== y.length) {
            return false;
        }
    }
    return true;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

export function meetsThreshold(c: Confidence, threshold: Confidence): boolean {
    return CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[threshold];
}
