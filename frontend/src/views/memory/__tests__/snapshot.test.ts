import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { AxClient } from "../../../transport/AxClient";
import { createNode } from "../nodes/layout";
import type { MemoryClass } from "../state/classSerialization";
import { useMemorySnapshot, type MemoryPoll } from "../state/useMemorySnapshot";
import type { PreviewMode } from "../state/viewerSettings";

// The poll loop under fake timers: immediate first read, one in-flight read at most (slow reads
// lower the effective rate instead of building a backlog), pause/resume/refresh-once, interval
// changes, region-change cancellation, preview planning, and the RTTI cache epoch.

interface Harness {
    poll: MemoryPoll;
    dispose: () => void;
    readCalls: () => number;
    batchCalls: () => string[][];
    rttiCalls: () => string[][];
    resolveRead: () => void;
    setManual: (on: boolean) => void;
    setCls: (cls: MemoryClass) => void;
    setPaused: (paused: boolean) => void;
    setIntervalMs: (ms: number) => void;
    setEpoch: (key: string) => void;
    setExpanded: (ids: ReadonlySet<string>) => void;
    setMode: (mode: PreviewMode) => void;
    setBudget: (n: number) => void;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function makeHarness(cls0: MemoryClass, regionHex?: string, manualFromStart = false): Harness {
    let readCount = 0;
    const batches: string[][] = [];
    const rttis: string[][] = [];
    let manual = manualFromStart;
    const pending: (() => void)[] = [];

    const client = {
        request: (type: string, payload: Record<string, unknown>) => {
            if (type === "read") {
                readCount++;
                const size = payload.size as number;
                const result = { success: true, data: regionHex ?? "00".repeat(size) };
                if (manual) {
                    return new Promise((resolve) => pending.push(() => resolve(result)));
                }
                return Promise.resolve(result);
            }
            if (type === "read_batch") {
                const reads = payload.reads as { address: string }[];
                batches.push(reads.map((r) => r.address));
                return Promise.resolve({ results: reads.map(() => ({ success: true, data: "00".repeat(16) })) });
            }
            if (type === "rtti_resolve_batch") {
                const addresses = payload.addresses as string[];
                rttis.push(addresses);
                return Promise.resolve({ results: addresses.map(() => ({ success: false })) });
            }
            throw new Error(`unexpected request ${type}`);
        },
    } as unknown as AxClient;

    const [cls, setCls] = createSignal<MemoryClass>(cls0);
    const [paused, setPaused] = createSignal(false);
    const [intervalMs, setIntervalMs] = createSignal(250);
    const [epoch, setEpoch] = createSignal("ws1");
    const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
    const [mode, setMode] = createSignal<PreviewMode>("all");
    const [budget, setBudget] = createSignal(16);

    let poll!: MemoryPoll;
    const dispose = createRoot((d) => {
        poll = useMemorySnapshot(client, cls, () => true, {
            intervalMs,
            paused,
            previewMode: mode,
            maxPreviews: budget,
            expandedIds: expanded,
            selectedIds: () => [],
            visibleIds: () => new Set(),
            cacheEpoch: epoch,
        });
        return d;
    });

    return {
        poll,
        dispose,
        readCalls: () => readCount,
        batchCalls: () => batches,
        rttiCalls: () => rttis,
        resolveRead: () => pending.shift()?.(),
        setManual: (on) => (manual = on),
        setCls,
        setPaused,
        setIntervalMs,
        setEpoch,
        setExpanded,
        setMode,
        setBudget,
    };
}

const plainClass = (): MemoryClass => ({
    id: "c1",
    name: "C",
    address: "0x1000",
    nodes: [createNode("uint32", "a")],
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("poll scheduling", () => {
    it("reads immediately, then on the configured interval", async () => {
        const h = makeHarness(plainClass());
        await flush();
        expect(h.readCalls()).toBe(1);
        expect(h.poll.data()?.view.byteLength).toBe(4);

        await vi.advanceTimersByTimeAsync(250);
        expect(h.readCalls()).toBe(2);
        await vi.advanceTimersByTimeAsync(500);
        expect(h.readCalls()).toBe(4);
        h.dispose();
    });

    it("keeps at most one read in flight - a slow agent lowers the rate, no backlog", async () => {
        const h = makeHarness(plainClass(), undefined, true);
        await flush();
        expect(h.readCalls()).toBe(1);
        expect(h.poll.reading()).toBe(true);

        // Time marches on while the read hangs: nothing else may be issued.
        await vi.advanceTimersByTimeAsync(2000);
        expect(h.readCalls()).toBe(1);

        h.resolveRead();
        await flush();
        expect(h.poll.reading()).toBe(false);
        // Next tick is scheduled only after the settle.
        await vi.advanceTimersByTimeAsync(250);
        expect(h.readCalls()).toBe(2);
        h.dispose();
    });

    it("applies an interval change to subsequent ticks", async () => {
        const h = makeHarness(plainClass());
        await flush();
        expect(h.readCalls()).toBe(1);

        await vi.advanceTimersByTimeAsync(250);
        expect(h.readCalls()).toBe(2);

        h.setIntervalMs(100);
        // The tick already scheduled at settle #2 still fires on the old 250ms delay...
        await vi.advanceTimersByTimeAsync(100);
        expect(h.readCalls()).toBe(2);
        await vi.advanceTimersByTimeAsync(150);
        expect(h.readCalls()).toBe(3);
        // ...and every tick scheduled from then on uses the new 100ms interval.
        await vi.advanceTimersByTimeAsync(100);
        expect(h.readCalls()).toBe(4);
        h.dispose();
    });
});

describe("pause / resume / refresh-once", () => {
    it("pausing freezes the snapshot and stops new reads", async () => {
        const h = makeHarness(plainClass());
        await flush();
        expect(h.readCalls()).toBe(1);
        const frozen = h.poll.data();
        expect(frozen).toBeTruthy();

        h.setPaused(true);
        await vi.advanceTimersByTimeAsync(5000);
        expect(h.readCalls()).toBe(1);
        expect(h.poll.data()).toBe(frozen); // frozen, not cleared
        h.dispose();
    });

    it("refreshOnce performs exactly one read without resuming", async () => {
        const h = makeHarness(plainClass());
        await flush();
        h.setPaused(true);
        await flush();

        h.poll.refreshOnce();
        await flush();
        expect(h.readCalls()).toBe(2);

        await vi.advanceTimersByTimeAsync(5000);
        expect(h.readCalls()).toBe(2); // still paused - no schedule was created
        h.dispose();
    });

    it("refreshOnce is ignored while a read is already in flight", async () => {
        const h = makeHarness(plainClass(), undefined, true);
        await flush();
        expect(h.readCalls()).toBe(1);
        h.poll.refreshOnce();
        h.poll.refreshOnce();
        expect(h.readCalls()).toBe(1);
        h.resolveRead();
        await flush();
        h.dispose();
    });

    it("resuming restarts the loop immediately", async () => {
        const h = makeHarness(plainClass());
        await flush();
        h.setPaused(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(h.readCalls()).toBe(1);

        h.setPaused(false);
        await flush();
        expect(h.readCalls()).toBe(2);
        await vi.advanceTimersByTimeAsync(250);
        expect(h.readCalls()).toBe(3);
        h.dispose();
    });
});

describe("region identity", () => {
    it("a region change clears data and abandons the in-flight read", async () => {
        const h = makeHarness(plainClass(), undefined, true);
        await flush();
        expect(h.readCalls()).toBe(1);

        h.setCls({ ...plainClass(), address: "0x2000" });
        await flush();
        expect(h.poll.data()).toBeNull(); // old bytes dropped instantly
        expect(h.readCalls()).toBe(2); // new region read starts NOW

        // The stale read settling must not repopulate data with the old region's bytes.
        h.resolveRead();
        await flush();
        expect(h.poll.data()).toBeNull();

        h.resolveRead(); // the new region's read
        await flush();
        expect(h.poll.data()?.key).toContain("0x2000");
        h.dispose();
    });
});

describe("pointer previews in the poll", () => {
    // Region: two pointers to the SAME target and one to another - 24 bytes.
    const ptrClass = (): MemoryClass => ({
        id: "c1",
        name: "P",
        address: "0x1000",
        nodes: [createNode("pointer", "a"), createNode("pointer", "b"), createNode("pointer", "c")],
    });
    // LE qwords: a=0x20000, b=0x20000, c=0x30000
    const hex = "0000020000000000" + "0000020000000000" + "0000030000000000";

    it("deduplicates targets and enforces the budget with stats", async () => {
        const h = makeHarness(ptrClass(), hex);
        await flush();
        expect(h.batchCalls()[0]).toEqual(["0x20000", "0x30000"]);
        expect(h.poll.data()?.previewStats).toEqual({ eligible: 2, read: 2, skipped: 0 });
        h.dispose();
    });

    it("budget cuts the lowest-priority targets and reports them skipped", async () => {
        const h = makeHarness(ptrClass(), hex);
        h.setBudget(1);
        h.setExpanded(new Set()); // no priority - order falls back to first-seen
        await flush();
        expect(h.batchCalls()[0]).toEqual(["0x20000"]);
        expect(h.poll.data()?.previewStats).toEqual({ eligible: 2, read: 1, skipped: 1 });
        h.dispose();
    });

    it("mode 'expanded' reads only expanded pointers", async () => {
        const h = makeHarness(ptrClass(), hex);
        h.setMode("expanded");
        await flush();
        expect(h.batchCalls()[0] ?? []).toEqual([]);
        expect(h.poll.data()?.previewStats.read).toBe(0);
        h.dispose();
    });

    it("caches RTTI per target and re-resolves after a cache-epoch change", async () => {
        const h = makeHarness(ptrClass(), hex);
        await flush();
        expect(h.rttiCalls()).toHaveLength(1);
        expect(h.rttiCalls()[0]).toEqual(["0x20000", "0x30000"]);

        await vi.advanceTimersByTimeAsync(250); // second poll - both targets cached
        expect(h.rttiCalls()).toHaveLength(1);

        h.setEpoch("ws2"); // process/target switch clears the cache
        await vi.advanceTimersByTimeAsync(250);
        expect(h.rttiCalls()).toHaveLength(2);
        h.dispose();
    });
});
