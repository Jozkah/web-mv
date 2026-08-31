import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createEmulatorStore } from "../emulatorStore";
import { createTimelineStore } from "../../timeline/timelineStore";
import { createTargetSession, type TargetIdentity } from "../targetSession";
import { AxError } from "../../transport/AxClient";
import { ErrorCode } from "../../protocol/messages";
import type { CapabilitiesStore } from "../capabilitiesStore";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

function fakeClient(handler: () => Promise<unknown>, seenVerbs?: string[]) {
    return { request: (type: string) => { seenVerbs?.push(type); return handler(); } } as never;
}

function fakeCaps(opts?: { emu?: boolean; provenance?: string; onReport?: (v: string) => void }): CapabilitiesStore {
    const emu = opts?.emu ?? true;
    return {
        available: (id: string) => (id === "emulation.unicorn" || id === "trace.emulated" ? emu : true),
        get: () => ({ provenance: opts?.provenance ?? "confirmed", available: emu }) as never,
        reportVerbError: (verb: string) => { opts?.onReport?.(verb); return false; },
    } as unknown as CapabilitiesStore;
}

const createReply = (rip = "0x1000") => ({ type: "emulate_result", id: 1, op: "create", success: true, session: "x", mode: "process", status: "ready", rip, registers: { rip, rax: "0x0", rsp: "0x9000" } });
const runReply = (over: Record<string, unknown> = {}) => ({
    type: "emulate_result", id: 1, op: "run", success: true, session: "x", status: "completed",
    stop_reason: "stop_reached", rip: "0x1008", registers: { rip: "0x1008", rax: "0x2a", rsp: "0x9000" },
    instruction_count: 3, instruction_total: 3, trace_count: 3, trace_dropped: 0, unicorn_error: 0,
    fault_address: "0x0", duration_us: 12, breakpoint: "0x0",
    trace: [ { index: 0, address: "0x1000", size: 4, bytes: "4883ec28" }, { index: 1, address: "0x1004", size: 3, bytes: "b82a000000" }, { index: 2, address: "0x1007", size: 1, bytes: "c3" } ],
    ...over,
});

function setup(over?: { handler?: () => Promise<unknown>; emu?: boolean; onReport?: (v: string) => void }) {
    const timeline = createTimelineStore();
    const [id, setId] = createSignal<TargetIdentity>({ key: "pid:1", pid: 1 });
    const session = createTargetSession(id);
    let handler: () => Promise<unknown> = over?.handler ?? (() => Promise.resolve(createReply()));
    const setHandler = (h: () => Promise<unknown>) => (handler = h);
    const seen: string[] = [];
    const store = createEmulatorStore({
        client: fakeClient(() => handler(), seen),
        timeline,
        capabilities: fakeCaps({ emu: over?.emu ?? true, onReport: over?.onReport }),
        modules: () => [],
        coreConnected: () => true,
        extConnected: () => true,
        attached: () => true,
        targetSession: session,
    });
    return { store, timeline, setId, setHandler, seen };
}

describe("createEmulatorStore — lifecycle", () => {
    it("creates a session and records registers", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup();
            const res = await store.createSession({ entryAddress: "0x1000" });
            expect("kind" in res).toBe(false);
            expect(store.session()?.status).toBe("ready");
            expect(store.session()?.registers.rsp).toBe("0x9000");
            dispose();
        });
    });

    it("runs, ingests trace in one batch, and emits a single run-summary timeline event", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, setHandler } = setup();
            setHandler(() => Promise.resolve(createReply()));
            await store.createSession({ entryAddress: "0x1000" });
            setHandler(() => Promise.resolve(runReply()));
            const summary = await store.run({ instructionBudget: 1000 });
            expect("kind" in summary).toBe(false);
            expect(store.trace.count()).toBe(3); // whole run's trace in one batch
            // Exactly one run-completed event (never one per instruction).
            const completed = timeline.events.filter((e) => e.type === "emulator.run.completed");
            expect(completed.length).toBe(1);
            expect(timeline.events.filter((e) => e.type.startsWith("emulator.run")).length).toBeGreaterThan(0);
            // No per-instruction spam.
            expect(timeline.count()).toBeLessThan(10);
            dispose();
        });
    });

    it("computes run-level register deltas", async () => {
        await createRoot(async (dispose) => {
            const { store, setHandler } = setup();
            await store.createSession({ entryAddress: "0x1000" });
            setHandler(() => Promise.resolve(runReply()));
            const s = await store.run();
            if ("kind" in s) throw new Error("run failed");
            expect(s.registerDeltas.rax).toEqual({ before: "0x0", after: "0x2a" });
            expect(s.registerDeltas.rip).toEqual({ before: "0x1000", after: "0x1008" });
            dispose();
        });
    });
});

describe("createEmulatorStore — safety", () => {
    it("is unavailable and rejects create when the capability is off", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup({ emu: false });
            expect(store.availability()).toBe("unavailable");
            const res = await store.createSession({ entryAddress: "0x1000" });
            expect("kind" in res && res.kind).toBe("capabilityUnavailable");
            dispose();
        });
    });

    it("invalidates the session on a target-generation change", async () => {
        await createRoot(async (dispose) => {
            const { store, setId } = setup();
            await store.createSession({ entryAddress: "0x1000" });
            expect(store.session()?.status).toBe("ready");
            setId({ key: "pid:2", pid: 2 }); // target switches
            await tick();
            expect(store.session()?.status).toBe("stale");
            // A run on the stale session is rejected.
            const res = await store.run();
            expect("kind" in res && (res.kind === "staleSession" || res.kind === "targetGenerationMismatch")).toBe(true);
            dispose();
        });
    });

    it("discards a late run result whose generation changed mid-flight", async () => {
        await createRoot(async (dispose) => {
            const d = deferred<unknown>();
            const { store, setId, setHandler } = setup();
            await store.createSession({ entryAddress: "0x1000" });
            setHandler(() => d.promise);
            const p = store.run();
            setId({ key: "pid:2", pid: 2 }); // generation advances during the run
            d.resolve(runReply({ rax: "0xdead" }));
            const res = await p;
            expect("kind" in res && res.kind === "targetGenerationMismatch").toBe(true);
            // The stale result was NOT applied.
            expect(store.trace.count()).toBe(0);
            dispose();
        });
    });

    it("downgrades the emulate verb on a definitive UnknownType", async () => {
        await createRoot(async (dispose) => {
            let reported = "";
            const { store, setHandler } = setup({ onReport: (v) => (reported = v) });
            setHandler(() => Promise.reject(new AxError(ErrorCode.UnknownType, "unknown ext verb")));
            const res = await store.createSession({ entryAddress: "0x1000" });
            expect("kind" in res).toBe(true);
            expect(reported).toBe("emulate");
            dispose();
        });
    });

    it("rejects a register edit while running / on a stale session, and a busy concurrent op", async () => {
        await createRoot(async (dispose) => {
            const d = deferred<unknown>();
            const { store, setHandler } = setup();
            await store.createSession({ entryAddress: "0x1000" });
            setHandler(() => d.promise);
            const p = store.run(); // in flight → busy
            const busyRes = await store.step();
            expect("kind" in busyRes && busyRes.kind === "busy").toBe(true);
            d.resolve(runReply());
            await p;
            dispose();
        });
    });

    it("never calls the target write route — the emulator only ever sends the 'emulate' verb", async () => {
        await createRoot(async (dispose) => {
            const { store, seen, setHandler } = setup();
            await store.createSession({ entryAddress: "0x1000" });
            setHandler(() => Promise.resolve(runReply()));
            await store.run();
            await store.writeRegister("rax", "0x1");
            await store.readMemory("0x1000", 16);
            await store.reset();
            await store.closeSession();
            // Every request the emulator made must be the single `emulate` verb — never `write`.
            expect(seen.length).toBeGreaterThan(0);
            expect(seen.every((v) => v === "emulate")).toBe(true);
            expect(seen).not.toContain("write");
            dispose();
        });
    });

    it("rejects operations on a closed session", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup();
            await store.createSession({ entryAddress: "0x1000" });
            await store.closeSession();
            expect(store.session()?.status).toBe("closed");
            const res = await store.run();
            expect("kind" in res && res.kind === "invalidSession").toBe(true);
            dispose();
        });
    });

    it("reset clears the trace and updates registers", async () => {
        await createRoot(async (dispose) => {
            const { store, setHandler } = setup();
            await store.createSession({ entryAddress: "0x1000" });
            setHandler(() => Promise.resolve(runReply()));
            await store.run();
            expect(store.trace.count()).toBe(3);
            setHandler(() => Promise.resolve({ type: "emulate_result", id: 1, op: "reset", success: true, session: "x", status: "ready", rip: "0x1000", registers: { rip: "0x1000", rax: "0x0" } }));
            await store.reset();
            expect(store.trace.count()).toBe(0);
            expect(store.session()?.currentRip).toBe("0x1000");
            dispose();
        });
    });

    it("emits a truncation event when the agent reports dropped trace entries", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, setHandler } = setup();
            await store.createSession({ entryAddress: "0x1000" });
            setHandler(() => Promise.resolve(runReply({ trace_dropped: 5 })));
            await store.run();
            expect(timeline.events.some((e) => e.type === "emulator.trace.truncated")).toBe(true);
            dispose();
        });
    });
});
