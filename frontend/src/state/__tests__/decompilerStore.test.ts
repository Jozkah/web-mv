import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createDecompilerStore, type GhidraTransport } from "../decompilerStore";
import { createTimelineStore } from "../../timeline/timelineStore";
import { createTargetSession, type TargetIdentity } from "../targetSession";
import { GHIDRA_DEFAULTS, type GhidraConfig } from "../ghidraConfig";
import type { CapabilitiesStore } from "../capabilitiesStore";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const ANALYSIS = JSON.stringify({
    format: "web-mv.ghidra.analysis",
    schemaVersion: 1,
    imageBase: "0x140000000",
    functions: [{ address: "0x140001000", name: "main", size: 16 }],
    symbols: [],
});
const DECOMPILE = JSON.stringify({ format: "web-mv.ghidra.decompile", schemaVersion: 1, functionEntry: "0x140001000", functionName: "main", cText: "int main(){}", warnings: [], timedOut: false, truncated: false, found: true });

function fakeCaps(available: boolean): CapabilitiesStore {
    return { available: () => available, get: () => ({ available, provenance: available ? "confirmed" : "disconnected" }) as never, reportVerbError: () => false } as unknown as CapabilitiesStore;
}

function setup(over?: { available?: boolean; transport?: Partial<GhidraTransport> }) {
    const timeline = createTimelineStore();
    const [id, setId] = createSignal<TargetIdentity>({ key: "pid:1", pid: 1 });
    const session = createTargetSession(id);
    const [config] = createSignal<GhidraConfig>({ ...GHIDRA_DEFAULTS, enabled: true, analyzeHeadlessPath: "C:/ghidra/analyzeHeadless.bat", dumpDirectory: "C:/dmp" });
    const sidecar = vi.fn();
    const analyzeSpy = vi.fn(() => Promise.resolve({ ok: true, analysisId: "an_1", export: ANALYSIS, durationMs: 5 }));
    const decompileSpy = vi.fn(() => Promise.resolve({ ok: true, result: DECOMPILE, durationMs: 3 }));
    const transport: GhidraTransport = {
        probe: over?.transport?.probe ?? (() => Promise.resolve({ ok: true, pathValid: true })),
        analyze: (over?.transport?.analyze as GhidraTransport["analyze"]) ?? (analyzeSpy as unknown as GhidraTransport["analyze"]),
        decompile: (over?.transport?.decompile as GhidraTransport["decompile"]) ?? (decompileSpy as unknown as GhidraTransport["decompile"]),
    };
    const store = createDecompilerStore({
        config,
        capabilities: fakeCaps(over?.available ?? true),
        timeline,
        setSidecar: sidecar,
        modules: () => [{ name: "game.exe", base: "0x7ff600000000", size: 0x10000 }],
        liveBaseOf: () => "0x7ff600000000",
        imageBaseOf: () => Promise.resolve("0x140000000"),
        dumpModule: () => Promise.resolve({ ok: true, path: "game.exe_dump.bin" }),
        targetSession: session,
        transport,
    });
    return { store, timeline, sidecar, setId, analyzeSpy, decompileSpy };
}

describe("createDecompilerStore — metadata analysis (no eager decompile)", () => {
    it("probes and flips the sidecar; state is readyUnvalidated until a real analysis", async () => {
        await createRoot(async (dispose) => {
            const { store, sidecar } = setup();
            await tick();
            expect(sidecar).toHaveBeenCalledWith("ghidra", true);
            expect(store.sidecarState()).toBe("readyUnvalidated");
            dispose();
        });
    });

    it("analyzes metadata only — never invokes the decompiler — then marks liveValidated", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, decompileSpy } = setup();
            const r = await store.analyzeModule("game.exe");
            expect(r.ok).toBe(true);
            expect(store.metadata("game.exe")!.length).toBe(1);
            expect(store.metadata("game.exe")![0].liveAddress).toBe("0x7ff600001000");
            // No pseudocode carried in metadata; no decompile call happened during analysis.
            expect((store.metadata("game.exe")![0] as unknown as Record<string, unknown>).pseudocode).toBeUndefined();
            expect(decompileSpy).not.toHaveBeenCalled();
            expect(store.sidecarState()).toBe("liveValidated");
            expect(timeline.events.some((e) => e.type === "decompiler.job.completed")).toBe(true);
            expect(timeline.events.some((e) => e.type.startsWith("analysis.ghidra.decompile"))).toBe(false);
            dispose();
        });
    });
});

describe("createDecompilerStore — explicit per-function decompilation", () => {
    it("decompiles exactly one function only on explicit request and caches it", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, decompileSpy } = setup();
            await store.analyzeModule("game.exe");
            expect(decompileSpy).toHaveBeenCalledTimes(0); // not during analysis
            const r = await store.decompileFunction("game.exe", "0x140001000");
            expect(r.ok).toBe(true);
            expect(decompileSpy).toHaveBeenCalledTimes(1);
            expect(store.cachedPseudo("game.exe", "0x140001000")!.functionName).toBe("main");
            expect(timeline.events.some((e) => e.type === "analysis.ghidra.decompileCompleted")).toBe(true);
            dispose();
        });
    });

    it("returns a cache hit without a second decompile", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, decompileSpy } = setup();
            await store.analyzeModule("game.exe");
            await store.decompileFunction("game.exe", "0x140001000");
            const r = await store.decompileFunction("game.exe", "0x140001000");
            expect(r.cached).toBe(true);
            expect(decompileSpy).toHaveBeenCalledTimes(1);
            expect(timeline.events.some((e) => e.type === "analysis.ghidra.decompileCacheHit")).toBe(true);
            dispose();
        });
    });

    it("deduplicates concurrent identical requests into one decompile", async () => {
        await createRoot(async (dispose) => {
            const { store, decompileSpy } = setup();
            await store.analyzeModule("game.exe");
            await Promise.all([store.decompileFunction("game.exe", "0x140001000"), store.decompileFunction("game.exe", "0x140001000")]);
            expect(decompileSpy).toHaveBeenCalledTimes(1);
            dispose();
        });
    });

    it("rejects an invalid function entry and analysis-not-run", async () => {
        await createRoot(async (dispose) => {
            const { store, decompileSpy } = setup();
            expect((await store.decompileFunction("game.exe", "main")).ok).toBe(false); // invalid entry
            expect((await store.decompileFunction("game.exe", "0x140001000")).ok).toBe(false); // no analysis yet
            expect(decompileSpy).not.toHaveBeenCalled();
            dispose();
        });
    });

    it("refuses everything when the capability is unavailable", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup({ available: false });
            expect((await store.analyzeModule("game.exe")).ok).toBe(false);
            expect((await store.decompileFunction("game.exe", "0x140001000")).ok).toBe(false);
            dispose();
        });
    });

    it("discards a decompile whose target generation changed", async () => {
        await createRoot(async (dispose) => {
            let resolveDec!: (v: unknown) => void;
            const pending = new Promise((r) => (resolveDec = r));
            const { store, setId } = setup({ transport: { decompile: (() => pending) as unknown as GhidraTransport["decompile"] } });
            await store.analyzeModule("game.exe");
            const p = store.decompileFunction("game.exe", "0x140001000");
            setId({ key: "pid:2", pid: 2 });
            resolveDec({ ok: true, result: DECOMPILE });
            const r = await p;
            expect(r.ok).toBe(false);
            expect(store.cachedPseudo("game.exe", "0x140001000")).toBeUndefined();
            dispose();
        });
    });
});
