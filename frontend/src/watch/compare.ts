import type { DecodedWatchValue, WatchPredicate, WatchValueType } from "./model";

// Pure comparison semantics for Memory Watch. Every function is total (never throws) and returns a
// deterministic result, so predicates can be exhaustively unit-tested. Signedness comes from the
// decoded value's kind; floats compare as numbers with optional epsilon; NaN never compares as a
// normal number (an equality/order test involving NaN is false, matched-ness is false).

// Whether the raw bytes changed between two successful reads (drives changeCount). A failed read is
// never treated as a change.
export function bytesChanged(a: DecodedWatchValue | undefined, b: DecodedWatchValue | undefined): boolean {
    if (!a?.ok || !b?.ok) return false;
    return a.bytesHex !== b.bytesHex;
}

interface Num {
    big?: bigint;
    f?: number;
}

function numeric(v: DecodedWatchValue | undefined): Num | undefined {
    if (!v?.ok) return undefined;
    if (v.float !== undefined) return { f: v.float };
    if (v.int !== undefined) return { big: v.int };
    if (v.bool !== undefined) return { big: v.bool ? 1n : 0n };
    return undefined;
}

function isFloatType(t: WatchValueType): boolean {
    return t === "float32" || t === "float64";
}

// Parse a constant operand into a numeric of the value's kind. Returns undefined on malformed input.
function operandNumeric(operand: string | undefined, valueType: WatchValueType): Num | undefined {
    if (operand === undefined || operand.trim() === "") return undefined;
    const raw = operand.trim();
    if (isFloatType(valueType)) {
        const n = Number(raw);
        if (Number.isNaN(n) && raw !== "NaN") return undefined;
        return { f: n };
    }
    try {
        return { big: BigInt(raw) };
    } catch {
        // Allow a decimal float operand against an integer watch by truncation (best-effort).
        const n = Number(raw);
        return Number.isFinite(n) ? { big: BigInt(Math.trunc(n)) } : undefined;
    }
}

// Compare two numerics. Returns -1/0/1, or undefined when incomparable (NaN involved).
function cmp(a: Num, b: Num): number | undefined {
    if (a.f !== undefined || b.f !== undefined) {
        const af = a.f ?? Number(a.big);
        const bf = b.f ?? Number(b.big);
        if (Number.isNaN(af) || Number.isNaN(bf)) return undefined;
        return af < bf ? -1 : af > bf ? 1 : 0;
    }
    const ab = a.big!;
    const bb = b.big!;
    return ab < bb ? -1 : ab > bb ? 1 : 0;
}

function approxEqual(a: Num, b: Num, epsilon?: number): boolean {
    if (a.f !== undefined || b.f !== undefined) {
        const af = a.f ?? Number(a.big);
        const bf = b.f ?? Number(b.big);
        if (Number.isNaN(af) || Number.isNaN(bf)) return false;
        return Math.abs(af - bf) <= (epsilon ?? 0);
    }
    return a.big === b.big;
}

function diff(a: Num, b: Num): Num {
    if (a.f !== undefined || b.f !== undefined) {
        const af = a.f ?? Number(a.big);
        const bf = b.f ?? Number(b.big);
        return { f: af - bf };
    }
    return { big: a.big! - b.big! };
}

// Numeric delta (current − previous) as a display string, for the table's Delta column.
export function computeDelta(cur: DecodedWatchValue | undefined, prev: DecodedWatchValue | undefined): string | undefined {
    const a = numeric(cur);
    const b = numeric(prev);
    if (!a || !b) return undefined;
    const d = diff(a, b);
    if (d.f !== undefined) {
        if (Number.isNaN(d.f)) return undefined;
        const r = Number(d.f.toFixed(6));
        return r >= 0 ? `+${r}` : `${r}`;
    }
    return d.big! >= 0n ? `+${d.big}` : `${d.big}`;
}

function bit(v: DecodedWatchValue | undefined, index: number): number | undefined {
    if (!v?.ok || v.int === undefined || index < 0) return undefined;
    return Number((v.int >> BigInt(index)) & 1n);
}

export interface CompareContext {
    valueType: WatchValueType;
    current?: DecodedWatchValue;
    previous?: DecodedWatchValue;
    baseline?: DecodedWatchValue;
}

// Resolve the reference sample a predicate compares against, per its basis.
function reference(pred: WatchPredicate, ctx: CompareContext): DecodedWatchValue | undefined {
    return pred.basis === "baseline" ? ctx.baseline : ctx.previous;
}

// Evaluate a predicate against the current sample. Returns false when required data is missing
// (e.g. no previous sample yet, or a decode failure) — a predicate never fires on incomplete data.
export function evaluatePredicate(pred: WatchPredicate, ctx: CompareContext): boolean {
    const cur = ctx.current;
    if (!cur?.ok) return false;
    const ref = reference(pred, ctx);
    const curNum = numeric(cur);
    const refNum = pred.basis === "constant" ? operandNumeric(pred.operand, ctx.valueType) : numeric(ref);

    switch (pred.mode) {
        case "changed":
            return pred.basis === "constant"
                ? !!curNum && !!refNum && cmp(curNum, refNum) !== 0
                : !!ref?.ok && cur.bytesHex !== ref.bytesHex;
        case "unchanged":
            return pred.basis === "constant"
                ? !!curNum && !!refNum && cmp(curNum, refNum) === 0
                : !!ref?.ok && cur.bytesHex === ref.bytesHex;
        case "increased":
            return !!curNum && !!refNum && cmp(curNum, refNum) === 1;
        case "decreased":
            return !!curNum && !!refNum && cmp(curNum, refNum) === -1;
        case "increasedBy": {
            if (!curNum || !refNum) return false;
            const amt = operandNumeric(pred.operand, ctx.valueType);
            return !!amt && approxEqual(diff(curNum, refNum), amt, pred.epsilon);
        }
        case "decreasedBy": {
            if (!curNum || !refNum) return false;
            const amt = operandNumeric(pred.operand, ctx.valueType);
            return !!amt && approxEqual(diff(refNum, curNum), amt, pred.epsilon);
        }
        case "equal":
            return !!curNum && !!refNum && approxEqual(curNum, refNum, pred.epsilon);
        case "notEqual":
            return !!curNum && !!refNum && !approxEqual(curNum, refNum, pred.epsilon);
        case "greater":
            return !!curNum && !!refNum && cmp(curNum, refNum) === 1;
        case "less":
            return !!curNum && !!refNum && cmp(curNum, refNum) === -1;
        case "greaterEqual": {
            if (!curNum || !refNum) return false;
            const c = cmp(curNum, refNum);
            return c === 1 || c === 0;
        }
        case "lessEqual": {
            if (!curNum || !refNum) return false;
            const c = cmp(curNum, refNum);
            return c === -1 || c === 0;
        }
        case "range": {
            if (!curNum) return false;
            const lo = operandNumeric(pred.operand, ctx.valueType);
            const hi = operandNumeric(pred.operandHigh, ctx.valueType);
            if (!lo || !hi) return false;
            const cl = cmp(curNum, lo);
            const ch = cmp(curNum, hi);
            return (cl === 0 || cl === 1) && (ch === 0 || ch === -1);
        }
        case "crossedUp": {
            const prevNum = numeric(ctx.previous);
            const thr = operandNumeric(pred.operand, ctx.valueType);
            if (!curNum || !prevNum || !thr) return false;
            return cmp(prevNum, thr) === -1 && cmp(curNum, thr) !== -1;
        }
        case "crossedDown": {
            const prevNum = numeric(ctx.previous);
            const thr = operandNumeric(pred.operand, ctx.valueType);
            if (!curNum || !prevNum || !thr) return false;
            return cmp(prevNum, thr) === 1 && cmp(curNum, thr) !== 1;
        }
        case "bitChanged": {
            const idx = pred.bitIndex ?? 0;
            const cb = bit(cur, idx);
            const rb = bit(ref, idx);
            return cb !== undefined && rb !== undefined && cb !== rb;
        }
        case "bitSet":
            return bit(cur, pred.bitIndex ?? 0) === 1;
        case "bitCleared":
            return bit(cur, pred.bitIndex ?? 0) === 0;
        case "pointerChanged":
            return !!ref?.ok && cur.bytesHex !== ref.bytesHex;
        case "bytePatternChanged":
        case "structureBytesChanged":
            return !!ref?.ok && cur.bytesHex !== ref.bytesHex;
        case "stringChanged":
            return !!ref?.ok && (cur.text ?? cur.bytesHex) !== (ref.text ?? ref.bytesHex);
        case "stringContains":
            return pred.operand !== undefined && (cur.text ?? "").includes(pred.operand);
        default:
            return false;
    }
}
