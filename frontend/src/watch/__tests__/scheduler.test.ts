import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWatchScheduler } from "../scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

interface Harness {
    intervals: number[];
    watchesByInterval: Map<number, string[]>;
    generation: number;
    active: boolean;
    runCycle: ReturnType<typeof vi.fn>;
}

function makeScheduler(h: Harness, runImpl?: (ids: string[], gen: number) => Promise<void>) {
    h.runCycle = vi.fn(runImpl ?? (() => Promise.resolve()));
    return createWatchScheduler({
        intervals: () => h.intervals,
        bucketWatches: (ms) => h.watchesByInterval.get(ms) ?? [],
        runCycle: (ids, gen) => (h.runCycle as (i: string[], g: number) => Promise<void>)(ids, gen),
        generation: () => h.generation,
        isActive: () => h.active,
    });
}

describe("createWatchScheduler", () => {
    it("creates one timer per interval bucket, not per watch", () => {
        const h: Harness = {
            intervals: [500, 1000],
            watchesByInterval: new Map([
                [500, ["a"]],
                [1000, ["b", "c", "d"]],
            ]),
            generation: 1,
            active: true,
            runCycle: vi.fn(),
        };
        const s = makeScheduler(h);
        s.start();
        expect(s.bucketCount()).toBe(2); // two buckets for four watches
        s.stop();
    });

    it("runs due watches for a bucket with the captured generation", () => {
        const h: Harness = {
            intervals: [1000],
            watchesByInterval: new Map([[1000, ["a", "b"]]]),
            generation: 7,
            active: true,
            runCycle: vi.fn(),
        };
        const s = makeScheduler(h);
        s.start();
        vi.advanceTimersByTime(1000);
        expect(h.runCycle).toHaveBeenCalledWith(["a", "b"], 7);
        s.stop();
    });

    it("coalesces: skips a tick while the previous cycle is still in flight", () => {
        const h: Harness = {
            intervals: [1000],
            watchesByInterval: new Map([[1000, ["a"]]]),
            generation: 1,
            active: true,
            runCycle: vi.fn(),
        };
        const s = makeScheduler(h, () => new Promise<void>(() => {})); // never resolves
        s.start();
        vi.advanceTimersByTime(3000); // three ticks, but the first cycle never completes
        expect(h.runCycle).toHaveBeenCalledTimes(1);
        expect(s.inFlight(1000)).toBe(true);
        s.stop();
    });

    it("does not read while paused (isActive false)", () => {
        const h: Harness = {
            intervals: [500],
            watchesByInterval: new Map([[500, ["a"]]]),
            generation: 1,
            active: false,
            runCycle: vi.fn(),
        };
        const s = makeScheduler(h);
        s.start();
        vi.advanceTimersByTime(2000);
        expect(h.runCycle).not.toHaveBeenCalled();
        // Resuming lets it run again.
        h.active = true;
        vi.advanceTimersByTime(500);
        expect(h.runCycle).toHaveBeenCalledTimes(1);
        s.stop();
    });

    it("skips a bucket with no due watches (no read traffic)", () => {
        const h: Harness = {
            intervals: [500],
            watchesByInterval: new Map([[500, []]]),
            generation: 1,
            active: true,
            runCycle: vi.fn(),
        };
        const s = makeScheduler(h);
        s.start();
        vi.advanceTimersByTime(2000);
        expect(h.runCycle).not.toHaveBeenCalled();
        s.stop();
    });

    it("readNow runs immediately outside the timer", async () => {
        const h: Harness = {
            intervals: [1000],
            watchesByInterval: new Map([[1000, ["a"]]]),
            generation: 3,
            active: true,
            runCycle: vi.fn(),
        };
        const s = makeScheduler(h);
        s.start();
        await s.readNow(["a", "b"]);
        expect(h.runCycle).toHaveBeenCalledWith(["a", "b"], 3);
        s.stop();
    });

    it("stop clears all timers (idle scheduler produces no traffic)", () => {
        const h: Harness = {
            intervals: [500],
            watchesByInterval: new Map([[500, ["a"]]]),
            generation: 1,
            active: true,
            runCycle: vi.fn(),
        };
        const s = makeScheduler(h);
        s.start();
        s.stop();
        vi.advanceTimersByTime(5000);
        expect(h.runCycle).not.toHaveBeenCalled();
        expect(s.bucketCount()).toBe(0);
    });
});
