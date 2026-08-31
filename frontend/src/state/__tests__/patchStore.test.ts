import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createPatchStore } from "../patchStore";
import { createTimelineStore } from "../../timeline/timelineStore";
import { createTargetSession, type TargetIdentity } from "../targetSession";
import type { CapabilitiesStore } from "../capabilitiesStore";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// A fake client that answers read_result / write_result. `original` is the bytes the target holds.
function fakeClient(state: { original: string; lastWrite?: string; writeOk?: boolean }) {
    return {
        request: (type: string, payload: Record<string, unknown>) => {
            if (type === "read") return Promise.resolve({ type: "read_result", id: 1, success: true, address: payload.address, size: payload.size, data: state.original });
            if (type === "write") { state.lastWrite = payload.data as string; return Promise.resolve({ type: "write_result", id: 1, success: state.writeOk ?? true, address: payload.address, bytes_written: 2 }); }
            return Promise.reject(new Error("unexpected verb " + type));
        },
    } as never;
}

function fakeCaps(available = true): CapabilitiesStore {
    return {
        available: () => available,
        get: () => ({ provenance: "confirmed", available }) as never,
        reportVerbError: () => false,
    } as unknown as CapabilitiesStore;
}

function setup(over?: { available?: boolean; original?: string }) {
    const timeline = createTimelineStore();
    const [id, setId] = createSignal<TargetIdentity>({ key: "pid:1", pid: 1 });
    const session = createTargetSession(id);
    const state = { original: over?.original ?? "9090", writeOk: true } as { original: string; lastWrite?: string; writeOk?: boolean };
    const store = createPatchStore({
        client: fakeClient(state),
        timeline,
        capabilities: fakeCaps(over?.available ?? true),
        modules: () => [],
        attached: () => true,
        liveKey: () => id().key,
        targetSession: session,
    });
    return { store, timeline, state, setId };
}

describe("createPatchStore", () => {
    it("captures original bytes on first apply, then writes the patched bytes", async () => {
        await createRoot(async (dispose) => {
            const { store, state, timeline } = setup({ original: "9090" });
            const pid = store.add({ expression: "0x1000", patchedBytes: "cc cc" });
            const err = await store.apply(pid);
            expect(err).toBeNull();
            expect(store.byId(pid)?.originalBytes).toBe("9090"); // captured
            expect(state.lastWrite).toBe("cccc"); // patched written
            expect(store.runtime(pid).status).toBe("applied");
            expect(timeline.events.some((e) => e.type === "patch.applied")).toBe(true);
            dispose();
        });
    });

    it("restores the original bytes", async () => {
        await createRoot(async (dispose) => {
            const { store, state } = setup({ original: "9090" });
            const pid = store.add({ expression: "0x1000", patchedBytes: "cccc" });
            await store.apply(pid);
            const err = await store.restore(pid);
            expect(err).toBeNull();
            expect(state.lastWrite).toBe("9090"); // original written back
            expect(store.runtime(pid).status).toBe("restored");
            dispose();
        });
    });

    it("is unavailable and refuses to apply without the write capability", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup({ available: false });
            expect(store.availability()).toBe("unavailable");
            const pid = store.add({ expression: "0x1000", patchedBytes: "cccc" });
            const err = await store.apply(pid);
            expect(err).toBeTruthy();
            expect(store.runtime(pid).status).toBe("error");
            dispose();
        });
    });

    it("marks applied patches stale on a target-generation change (never auto-restores)", async () => {
        await createRoot(async (dispose) => {
            const { store, setId } = setup();
            const pid = store.add({ expression: "0x1000", patchedBytes: "cccc" });
            await store.apply(pid);
            expect(store.runtime(pid).status).toBe("applied");
            setId({ key: "pid:2", pid: 2 });
            await tick();
            expect(store.runtime(pid).status).toBe("stale");
            dispose();
        });
    });

    it("imports patches disabled and never auto-applies", async () => {
        await createRoot(async (dispose) => {
            const { store, state } = setup();
            const json = JSON.stringify({ schemaVersion: 1, patches: [{ schemaVersion: 1, id: "x", name: "p", enabled: true, expression: "0x1000", patchedBytes: "cccc", originalBytes: "9090", tags: [], createdAt: "t", updatedAt: "t" }] });
            const n = store.importJSON(json);
            expect(n).toBe(1);
            const imported = store.patches().find((p) => p.name === "p")!;
            expect(imported.enabled).toBe(false); // disabled on import
            expect(state.lastWrite).toBeUndefined(); // nothing written
            dispose();
        });
    });
});
