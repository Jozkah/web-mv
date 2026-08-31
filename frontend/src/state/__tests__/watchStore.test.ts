import { describe, expect, it } from "vitest";
import { createEffect, createRoot, createSignal } from "solid-js";
import { createWatchStore } from "../watchStore";
import { createTimelineStore } from "../../timeline/timelineStore";
import { createTargetSession, type TargetIdentity } from "../targetSession";
import type { CapabilitiesStore } from "../capabilitiesStore";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

// A fake AxClient whose request() returns whatever the current handler yields. watchStore only ever
// calls request() for read_batch.
function fakeClient(handler: () => Promise<unknown>) {
    return { request: () => handler() } as never;
}

function fakeCaps(readOk = true): CapabilitiesStore {
    return {
        available: (id: string) => (id === "memory.read" ? readOk : false),
        get: () => ({ provenance: "derived", available: true }) as never,
        reportVerbError: () => false,
    } as unknown as CapabilitiesStore;
}

function batchReply(entries: { success: boolean; address: string; data: string }[]) {
    return { type: "read_batch_result", id: 1, success: true, results: entries };
}

interface Harness {
    handler: () => Promise<unknown>;
}

function setup(over?: { readOk?: boolean; harness?: Harness; identity?: TargetIdentity }) {
    const timeline = createTimelineStore();
    const [id, setId] = createSignal<TargetIdentity>(over?.identity ?? { key: "pid:1", pid: 1 });
    const session = createTargetSession(id);
    const h: Harness = over?.harness ?? { handler: () => Promise.resolve(batchReply([])) };
    const store = createWatchStore({
        client: fakeClient(() => h.handler()),
        timeline,
        capabilities: fakeCaps(over?.readOk ?? true),
        modules: () => [],
        coreConnected: () => false, // keep the background timer inert; readNow drives cycles manually
        attached: () => true,
        liveKey: () => id().key,
        targetSession: session,
        now: () => 0,
    });
    return { store, timeline, session, setId, h };
}

describe("createWatchStore — reads & decoding", () => {
    it("reads, decodes, and records the current value", async () => {
        await createRoot(async (dispose) => {
            const { store, h } = setup();
            const wid = store.add({ expression: "0x1000", valueType: "int32" });
            h.handler = () => Promise.resolve(batchReply([{ success: true, address: "0x1000", data: "01000000" }]));
            await store.readNow([wid]);
            expect(store.runtime(wid).current?.int).toBe(1n);
            expect(store.runtime(wid).status).toBe("ready");
            dispose();
        });
    });

    it("counts changes and emits a batched changed event (not on the first read)", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, h } = setup();
            const wid = store.add({ expression: "0x1000", valueType: "int32" });
            h.handler = () => Promise.resolve(batchReply([{ success: true, address: "0x1000", data: "01000000" }]));
            await store.readNow([wid]);
            expect(store.runtime(wid).changeCount).toBe(0); // first read establishes previous
            h.handler = () => Promise.resolve(batchReply([{ success: true, address: "0x1000", data: "02000000" }]));
            await store.readNow([wid]);
            expect(store.runtime(wid).current?.int).toBe(2n);
            expect(store.runtime(wid).changeCount).toBe(1);
            expect(timeline.events.some((e) => e.type === "memory.watch.changed")).toBe(true);
            dispose();
        });
    });
});

describe("createWatchStore — isolation & safety", () => {
    it("isolates a partial batch failure: one watch errors, the other stays healthy", async () => {
        await createRoot(async (dispose) => {
            const { store, h } = setup();
            const a = store.add({ expression: "0x1000", valueType: "int32" });
            const b = store.add({ expression: "0x2000", valueType: "int32" });
            h.handler = () =>
                Promise.resolve(
                    batchReply([
                        { success: true, address: "0x1000", data: "07000000" },
                        { success: false, address: "0x2000", data: "" },
                    ]),
                );
            await store.readNow([a, b]);
            expect(store.runtime(a).status).toBe("ready");
            expect(store.runtime(a).current?.int).toBe(7n);
            expect(store.runtime(b).status).toBe("error");
            expect(store.runtime(b).error?.kind).toBe("unreadable");
            dispose();
        });
    });

    it("discards a late response from a previous target generation (marks it stale)", async () => {
        await createRoot(async (dispose) => {
            const d = deferred<unknown>();
            const { store, setId } = setup({ harness: { handler: () => d.promise } });
            const wid = store.add({ expression: "0x1000", valueType: "int32" });
            const p = store.readNow([wid]); // captures the current generation, then awaits the read
            setId({ key: "pid:2", pid: 2 }); // target switches mid-flight → generation advances
            d.resolve(batchReply([{ success: true, address: "0x1000", data: "63000000" }])); // 99, but stale
            await p;
            await tick();
            expect(store.runtime(wid).status).toBe("stale");
            expect(store.runtime(wid).current).toBeUndefined(); // value NOT applied
            dispose();
        });
    });

    it("reports availability as unavailable when memory.read is not available", () => {
        createRoot((dispose) => {
            const { store } = setup({ readOk: false });
            expect(store.availability()).toBe("unavailable");
            dispose();
        });
    });
});

describe("createWatchStore — performance", () => {
    it("processes a 500-watch changed cycle with ONE timeline recomputation, under budget", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, h } = setup();
            const N = 500;
            const ids: string[] = [];
            for (let i = 0; i < N; i++) ids.push(store.add({ expression: `0x${(0x10000 + i * 8).toString(16)}`, valueType: "int32" }));

            // The batch reply echoes each requested read; `data` is a mutable per-cycle value so the
            // second read differs from the first (→ every watch reports a change).
            let val = "01000000";
            h.handler = () =>
                Promise.resolve({
                    type: "read_batch_result",
                    id: 1,
                    success: true,
                    results: undefined as unknown, // filled below
                });
            const makeHandler = (data: string) => () =>
                Promise.resolve({
                    type: "read_batch_result",
                    id: 1,
                    success: true,
                    // one result per requested entry, in order; the store maps by index.
                    results: Array.from({ length: 64 }, (_, k) => ({ success: true, address: `0x${(0x10000 + k * 8).toString(16)}`, data })),
                });

            // First read establishes previous values (no change events).
            h.handler = makeHandler(val);
            await store.readNow(ids);

            // Count timeline recomputations around the second (changed) cycle.
            let runs = 0;
            createEffect(() => {
                timeline.filtered();
                runs++;
            });
            await new Promise<void>((r) => setTimeout(r, 0));
            const before = runs;
            const beforeCount = timeline.count();

            val = "02000000";
            h.handler = makeHandler(val);
            const t0 = performance.now();
            await store.readNow(ids);
            const elapsed = performance.now() - t0;
            await new Promise<void>((r) => setTimeout(r, 0));

            const changeEvents = timeline.count() - beforeCount;
            // eslint-disable-next-line no-console
            console.log(`[perf] 500-watch changed cycle: ${elapsed.toFixed(1)}ms, ${changeEvents} change events, ${runs - before} timeline recomputes`);
            expect(changeEvents).toBeGreaterThan(0);
            // The whole 500-watch result set flows through ingestMany → the timeline recomputes at most
            // a small constant number of times, never once-per-watch.
            expect(runs - before).toBeLessThanOrEqual(8); // ≈ one per batch, not 500
            expect(elapsed).toBeLessThan(1000);
            dispose();
        });
    });
});

describe("createWatchStore — lifecycle events", () => {
    it("emits created / baselineCaptured / removed events", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, h } = setup();
            const wid = store.add({ expression: "0x1000", valueType: "int32" });
            h.handler = () => Promise.resolve(batchReply([{ success: true, address: "0x1000", data: "05000000" }]));
            await store.readNow([wid]);
            store.captureBaseline(wid);
            store.remove(wid);
            const types = timeline.events.map((e) => e.type);
            expect(types).toContain("memory.watch.created");
            expect(types).toContain("memory.watch.baselineCaptured");
            expect(types).toContain("memory.watch.removed");
            dispose();
        });
    });
});
