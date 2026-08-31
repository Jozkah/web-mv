// Central Memory Watch polling scheduler. ONE timer per distinct effective interval (a bucket) —
// never one setInterval per watch. Each bucket tick, if the scheduler is active, captures the target
// generation, gathers the bucket's due watches, and runs a single cycle; a cycle already in flight
// for that bucket is skipped (coalesced) so reads never overlap for the same bucket. Timing and
// activity gating live here; the actual resolve/read/decode/compare work is the injected runCycle.

type TimerHandle = ReturnType<typeof setInterval>;

export interface SchedulerConfig {
    // Distinct effective interval buckets currently in use (ms).
    intervals: () => number[];
    // Enabled watch ids due on a given interval bucket.
    bucketWatches: (intervalMs: number) => string[];
    // Run one polling cycle for these watches at the captured generation. Resolves when done.
    runCycle: (watchIds: string[], generation: number) => Promise<void>;
    // Live target generation (captured at cycle start, checked by runCycle on completion).
    generation: () => number;
    // Whether polling should run at all: core connected, target attached, not paused, page visible.
    isActive: () => boolean;
    // Injectable timers (tests use fake timers via the globals; overridable for isolation).
    setTimer?: (fn: () => void, ms: number) => TimerHandle;
    clearTimer?: (h: TimerHandle) => void;
}

interface Bucket {
    handle: TimerHandle;
    inFlight: boolean;
}

export function createWatchScheduler(config: SchedulerConfig) {
    const setTimer = config.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    const clearTimer = config.clearTimer ?? ((h) => clearInterval(h));
    const buckets = new Map<number, Bucket>();
    let running = false;

    function runBucket(intervalMs: number): void {
        if (!running || !config.isActive()) return;
        const b = buckets.get(intervalMs);
        if (!b || b.inFlight) return; // coalesce: skip while the previous cycle is still in flight
        const ids = config.bucketWatches(intervalMs);
        if (ids.length === 0) return;
        const gen = config.generation();
        b.inFlight = true;
        config
            .runCycle(ids, gen)
            .catch(() => {
                /* runCycle isolates per-watch failures; a thrown cycle must not kill the bucket */
            })
            .finally(() => {
                const cur = buckets.get(intervalMs);
                if (cur) cur.inFlight = false;
            });
    }

    // Reconcile live timers with the current interval set: add timers for new buckets, remove timers
    // for buckets that no longer have any watches. Idempotent; call whenever watches change.
    function sync(): void {
        const desired = new Set(config.intervals().filter((ms) => ms > 0));
        for (const [ms, b] of buckets) {
            if (!desired.has(ms)) {
                clearTimer(b.handle);
                buckets.delete(ms);
            }
        }
        for (const ms of desired) {
            if (buckets.has(ms)) continue;
            const handle = setTimer(() => runBucket(ms), ms);
            buckets.set(ms, { handle, inFlight: false });
        }
    }

    function start(): void {
        if (running) return;
        running = true;
        sync();
    }

    function stop(): void {
        running = false;
        for (const b of buckets.values()) clearTimer(b.handle);
        buckets.clear();
    }

    // Manual "read now" for specific watches — bypasses the timer but still captures the current
    // generation and defers to runCycle (which enforces byte/stale limits).
    function readNow(watchIds: string[]): Promise<void> {
        if (watchIds.length === 0) return Promise.resolve();
        return config.runCycle(watchIds, config.generation());
    }

    return {
        start,
        stop,
        sync,
        readNow,
        isRunning: () => running,
        bucketCount: () => buckets.size,
        // Test/introspection: whether a bucket currently has a cycle in flight.
        inFlight: (intervalMs: number) => buckets.get(intervalMs)?.inFlight ?? false,
    };
}

export type WatchScheduler = ReturnType<typeof createWatchScheduler>;
