// Baseline capture/compare for the memory viewer: a frozen copy of the region's bytes taken on
// demand, diffed field-by-field against each later snapshot. Separate from the per-tick `prev`
// diff (which highlights what moved in the last poll) - the baseline highlights what moved since
// the user pressed "Baseline". Pure helpers; the signal holding the baseline lives in the view.

export interface Baseline {
    /** regionKey of the class this baseline was captured from. A baseline is only meaningful
     *  against the exact same region (class + address + layout size); any mismatch invalidates. */
    key: string;
    bytes: Uint8Array;
}

/** Freeze a snapshot's bytes as the new baseline. Copies, so later polls can't mutate it. */
export function captureBaseline(key: string, view: DataView): Baseline {
    const bytes = new Uint8Array(view.byteLength);
    for (let i = 0; i < view.byteLength; i++) bytes[i] = view.getUint8(i);
    return { key, bytes };
}

/** True when `baseline` still matches the region identified by `key` (same class, base address,
 *  and layout size). Changing any of those makes the byte-for-byte comparison meaningless. */
export function baselineValid(baseline: Baseline | undefined, key: string): baseline is Baseline {
    return baseline !== undefined && baseline.key === key && key !== "";
}

/** Whether the `size` bytes at `offset` differ from the baseline. Out-of-bounds on either side
 *  counts as unchanged (nothing meaningful to compare). */
export function changedFromBaseline(
    view: DataView,
    baseline: Baseline,
    offset: number,
    size: number,
): boolean {
    if (offset + size > view.byteLength || offset + size > baseline.bytes.length) return false;
    for (let i = 0; i < size; i++) {
        if (view.getUint8(offset + i) !== baseline.bytes[offset + i]) return true;
    }
    return false;
}

/** A DataView over the baseline bytes, for decoding "was" values (tooltip/compare rendering). */
export function baselineView(baseline: Baseline): DataView {
    return new DataView(baseline.bytes.buffer, baseline.bytes.byteOffset, baseline.bytes.byteLength);
}
