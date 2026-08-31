// Bounded per-watch sample history with a global byte budget and target-generation segmentation.
// Pure/plain data (no Solid reactivity) so it can be unit-tested and driven at high frequency; the
// store wraps it and bumps a version signal for the UI. Each watch keeps at most `historyLimit`
// samples; a global byte budget evicts the globally-oldest samples across all watches when exceeded.

export interface WatchSample {
    seq: number; // global monotonic sequence (also the total order across watches)
    timestamp: string;
    monotonicMs: number;
    generation: number;
    address: string;
    bytesHex: string; // bounded (already limited to the watch's read size)
    display: string;
    changed: boolean;
    matched?: boolean;
    triggered?: boolean;
    latencyMs?: number;
    error?: string;
}

interface WatchLane {
    samples: WatchSample[];
    dropped: number;
}

export const DEFAULT_GLOBAL_BYTE_BUDGET = 8 * 1024 * 1024; // 8 MiB across all watch histories

export function createWatchHistory(globalByteBudget: number = DEFAULT_GLOBAL_BYTE_BUDGET) {
    const lanes = new Map<string, WatchLane>();
    let seq = 0;
    let totalBytes = 0;

    const laneFor = (id: string): WatchLane => {
        let l = lanes.get(id);
        if (!l) lanes.set(id, (l = { samples: [], dropped: 0 }));
        return l;
    };

    const sampleBytes = (s: WatchSample): number => s.bytesHex.length >> 1;

    function evictOldestGlobally(): void {
        // Find the lane whose oldest sample has the smallest seq, and drop it.
        let victim: WatchLane | undefined;
        let victimSeq = Infinity;
        for (const l of lanes.values()) {
            if (l.samples.length === 0) continue;
            if (l.samples[0].seq < victimSeq) {
                victimSeq = l.samples[0].seq;
                victim = l;
            }
        }
        if (!victim) return;
        const [dropped] = victim.samples.splice(0, 1);
        totalBytes -= sampleBytes(dropped);
        victim.dropped += 1;
    }

    function push(
        id: string,
        sample: Omit<WatchSample, "seq">,
        historyLimit: number,
    ): WatchSample {
        seq += 1;
        const full: WatchSample = { ...sample, seq };
        const lane = laneFor(id);
        lane.samples.push(full);
        totalBytes += sampleBytes(full);

        // Per-watch cap.
        while (lane.samples.length > historyLimit) {
            const [d] = lane.samples.splice(0, 1);
            totalBytes -= sampleBytes(d);
            lane.dropped += 1;
        }
        // Global byte budget.
        while (totalBytes > globalByteBudget) evictOldestGlobally();

        return full;
    }

    function get(id: string): readonly WatchSample[] {
        return lanes.get(id)?.samples ?? [];
    }

    // Split a watch's history into contiguous segments by target generation, so a chart/table breaks
    // across process changes instead of drawing a misleading line between two different targets.
    function segments(id: string): WatchSample[][] {
        const out: WatchSample[][] = [];
        let cur: WatchSample[] | undefined;
        let gen: number | undefined;
        for (const s of get(id)) {
            if (cur === undefined || s.generation !== gen) {
                cur = [];
                out.push(cur);
                gen = s.generation;
            }
            cur.push(s);
        }
        return out;
    }

    function droppedFor(id: string): number {
        return lanes.get(id)?.dropped ?? 0;
    }

    function totalDropped(): number {
        let n = 0;
        for (const l of lanes.values()) n += l.dropped;
        return n;
    }

    function clear(id: string): void {
        const l = lanes.get(id);
        if (!l) return;
        for (const s of l.samples) totalBytes -= sampleBytes(s);
        l.samples = [];
    }

    function clearAll(): void {
        lanes.clear();
        totalBytes = 0;
    }

    function count(id: string): number {
        return lanes.get(id)?.samples.length ?? 0;
    }

    return {
        push,
        get,
        segments,
        droppedFor,
        totalDropped,
        clear,
        clearAll,
        count,
        bytes: () => totalBytes,
    };
}

export type WatchHistory = ReturnType<typeof createWatchHistory>;
