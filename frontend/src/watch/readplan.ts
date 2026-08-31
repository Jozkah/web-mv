// Pure read planning for a polling cycle: deduplicate identical reads, then pack them into bounded
// read_batch requests. Correctness over merge ratio — this only DEDUPLICATES identical
// address+size reads (a safe form of coalescing); it never merges across distinct/adjacent ranges,
// which would risk reading across unknown/unreadable region boundaries. Adjacency merging is a
// future optimization gated on region validation.

export interface WatchRead {
    watchId: string;
    address: string; // canonical lowercase hex
    size: number;
}

export interface BatchEntry {
    address: string;
    size: number;
    watchIds: string[]; // every watch whose read this entry satisfies
}

export interface ReadBatch {
    entries: BatchEntry[];
    totalBytes: number;
}

export interface PlanLimits {
    maxEntriesPerBatch: number;
    maxBytesPerBatch: number;
    maxBytesPerEntry: number;
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
    maxEntriesPerBatch: 64,
    maxBytesPerBatch: 256 * 1024, // 256 KiB per cycle batch
    maxBytesPerEntry: 0x10000, // 64 KiB — the read_batch per-entry ceiling
};

export interface PlanResult {
    batches: ReadBatch[];
    oversize: WatchRead[]; // reads whose size exceeds the per-entry limit — reported as errors upstream
}

export function planReadBatches(reads: readonly WatchRead[], limits: PlanLimits = DEFAULT_PLAN_LIMITS): PlanResult {
    const oversize: WatchRead[] = [];
    // Dedupe by address+size, preserving first-seen order for determinism.
    const byKey = new Map<string, BatchEntry>();
    for (const r of reads) {
        if (r.size <= 0) continue;
        if (r.size > limits.maxBytesPerEntry) {
            oversize.push(r);
            continue;
        }
        const key = `${r.address}:${r.size}`;
        const existing = byKey.get(key);
        if (existing) existing.watchIds.push(r.watchId);
        else byKey.set(key, { address: r.address, size: r.size, watchIds: [r.watchId] });
    }

    const entries = [...byKey.values()];
    const batches: ReadBatch[] = [];
    let cur: ReadBatch | null = null;
    for (const e of entries) {
        if (
            cur === null ||
            cur.entries.length >= limits.maxEntriesPerBatch ||
            cur.totalBytes + e.size > limits.maxBytesPerBatch
        ) {
            cur = { entries: [], totalBytes: 0 };
            batches.push(cur);
        }
        cur.entries.push(e);
        cur.totalBytes += e.size;
    }

    return { batches, oversize };
}
