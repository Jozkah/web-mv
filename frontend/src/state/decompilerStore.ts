import { createEffect, createSignal, on, type Accessor } from "solid-js";
import type { CapabilitiesStore } from "./capabilitiesStore";
import type { TargetSession } from "./targetSession";
import type { ModuleEntry } from "../protocol/types";
import { TimelineEventType, jsonDetails, type TimelineEventInput } from "../timeline/events";
import type { TimelineStore } from "../timeline/timelineStore";
import type { GhidraConfig } from "./ghidraConfig";
import { isValidFunctionEntry, mapAnalysis, parseGhidraAnalysis, parseGhidraDecompile, type GhidraDecompile, type MappedFunction } from "../decompiler/ghidraParse";

// Orchestrates the optional Ghidra adapter with a strict split (Phase 15.1):
//   1. Module analysis exports bounded METADATA only (no pseudocode, no per-function decompiler).
//   2. Pseudocode is fetched ONLY on an explicit per-function request, deduplicated + cached.
// Ghidra output is STATIC analysis (provenance Ghidra) — may be incomplete/incorrect/stale/mismapped,
// and never writes the target. Transport is injected so the orchestration is testable without Ghidra.

export type GhidraSidecarState = "unconfigured" | "pathValid" | "readyUnvalidated" | "liveValidated" | "failed" | "timedOut";

export interface GhidraProbeResult {
    ok: boolean;
    pathValid?: boolean;
    error?: string;
}
export interface GhidraAnalyzeResult {
    ok: boolean;
    analysisId?: string;
    export?: string;
    error?: string;
    durationMs?: number;
}
export interface GhidraDecompileResult {
    ok: boolean;
    result?: string;
    error?: string;
    durationMs?: number;
}
export interface GhidraTransport {
    probe(config: GhidraConfig): Promise<GhidraProbeResult>;
    analyze(config: GhidraConfig, job: { dumpFile: string; base: string; processor?: string }): Promise<GhidraAnalyzeResult>;
    decompile(config: GhidraConfig, job: { analysisId: string; moduleFingerprint: string; functionEntry: string; targetGeneration: number }): Promise<GhidraDecompileResult>;
}

export type DecompileJobState = "idle" | "dumping" | "analyzing" | "done" | "error";

export interface DecompilerDeps {
    config: Accessor<GhidraConfig>;
    capabilities: CapabilitiesStore;
    timeline: TimelineStore;
    setSidecar: (id: "ghidra", present: boolean) => void;
    modules: Accessor<readonly ModuleEntry[]>;
    liveBaseOf: (name: string) => string | undefined;
    imageBaseOf?: (name: string) => Promise<string | undefined>;
    dumpModule: (name: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
    targetSession: TargetSession;
    transport: GhidraTransport;
}

function fingerprint(m: ModuleEntry): string {
    return `${m.name}:${m.size}`;
}

interface MetadataEntry {
    analysisId: string;
    functions: MappedFunction[];
}

export function createDecompilerStore(deps: DecompilerDeps) {
    const [jobState, setJobState] = createSignal<DecompileJobState>("idle");
    const [lastError, setLastError] = createSignal<string>();
    const [sidecarState, setSidecarState] = createSignal<GhidraSidecarState>("unconfigured");
    const [decompileBusy, setDecompileBusy] = createSignal<string>(); // functionEntry currently decompiling
    const [version, bump] = createSignal(0, { equals: false });

    // Separate caches: module metadata (functions) vs. per-function pseudocode. A generation change
    // makes live mapping stale but does NOT destroy the static caches (they belong to the dump image).
    const metadataCache = new Map<string, MetadataEntry>(); // key: module fingerprint
    const pseudoCache = new Map<string, GhidraDecompile>(); // key: `${analysisId}:${entry}`
    const inflight = new Map<string, Promise<GhidraDecompileResult>>();

    const available = () => deps.capabilities.available("decompiler.ghidra");

    // Probe on config change. A path check only proves the executable exists (pathValid /
    // readyUnvalidated) — NOT that Ghidra can analyze a dump. That is `liveValidated`, reached only
    // after a real analysis succeeds. The sidecar flips so the capability is available for config/UI.
    createEffect(
        on(deps.config, (cfg) => {
            if (!cfg.enabled || cfg.analyzeHeadlessPath.trim() === "") {
                deps.setSidecar("ghidra", false);
                setSidecarState("unconfigured");
                return;
            }
            deps.transport
                .probe(cfg)
                .then((r) => {
                    deps.setSidecar("ghidra", r.ok);
                    setSidecarState((prev) => (prev === "liveValidated" ? prev : r.ok ? "readyUnvalidated" : "failed"));
                    if (!r.ok) setLastError(r.error);
                })
                .catch(() => {
                    deps.setSidecar("ghidra", false);
                    setSidecarState("failed");
                });
        }),
    );

    const emit = (input: TimelineEventInput) => deps.timeline.ingest(input);
    const evt = (type: string, severity: TimelineEventInput["severity"], summary: string, details?: Record<string, unknown>): TimelineEventInput => ({
        type,
        source: "decompiler",
        severity,
        summary,
        provenance: "Ghidra",
        confidence: "derived",
        targetGeneration: deps.targetSession.generation(),
        tags: ["ghidra"],
        details: details ? jsonDetails(details) : undefined,
    });

    // --- module metadata analysis (no decompiler) ---
    async function analyzeModule(moduleName: string): Promise<{ ok: boolean; error?: string; count?: number }> {
        if (!available()) return { ok: false, error: "decompiler.ghidra is not available (configure a local Ghidra install)" };
        const gen = deps.targetSession.generation();
        setLastError(undefined);
        setJobState("dumping");
        emit(evt(TimelineEventType.DecompilerJobStarted, "info", `Ghidra: analyzing ${moduleName}…`, { module: moduleName }));

        const dump = await deps.dumpModule(moduleName);
        if (!dump.ok || !dump.path) return failAnalysis("dump failed: " + (dump.error ?? "no path"), moduleName);
        if (deps.targetSession.isStale(gen)) return failAnalysis("target changed during dump", moduleName);

        const liveBase = deps.liveBaseOf(moduleName) ?? "0x0";
        const imageBase = (deps.imageBaseOf ? await deps.imageBaseOf(moduleName) : undefined) ?? liveBase;

        setJobState("analyzing");
        let res: GhidraAnalyzeResult;
        try {
            res = await deps.transport.analyze(deps.config(), { dumpFile: dump.path, base: liveBase });
        } catch (e) {
            return failAnalysis(e instanceof Error ? e.message : String(e), moduleName);
        }
        if (deps.targetSession.isStale(gen)) return failAnalysis("target changed during analysis", moduleName);
        if (!res.ok || !res.export || !res.analysisId) return failAnalysis(res.error ?? "Ghidra analysis failed", moduleName);

        let funcs: MappedFunction[];
        try {
            const analysis = parseGhidraAnalysis(res.export);
            funcs = mapAnalysis(analysis, liveBase, imageBase);
        } catch (e) {
            return failAnalysis(e instanceof Error ? e.message : String(e), moduleName);
        }

        const m = deps.modules().find((x) => x.name === moduleName);
        if (m) metadataCache.set(fingerprint(m), { analysisId: res.analysisId, functions: funcs });
        setSidecarState("liveValidated"); // a real dump analysis succeeded
        bump((n) => n + 1);
        setJobState("done");
        emit(evt(TimelineEventType.DecompilerJobCompleted, "info", `Ghidra: ${funcs.length} functions in ${moduleName} (metadata only — no pseudocode)`, { module: moduleName, functions: funcs.length, durationMs: res.durationMs }));
        return { ok: true, count: funcs.length };
    }

    function failAnalysis(message: string, moduleName: string): { ok: false; error: string } {
        setLastError(message);
        setJobState("error");
        if (/timed out|timeout/i.test(message)) setSidecarState("timedOut");
        emit(evt(TimelineEventType.DecompilerJobFailed, "warning", `Ghidra analysis failed for ${moduleName}: ${message}`, { module: moduleName, error: message }));
        return { ok: false, error: message };
    }

    function metadata(moduleName: string): MappedFunction[] | undefined {
        version();
        const m = deps.modules().find((x) => x.name === moduleName);
        return m ? metadataCache.get(fingerprint(m))?.functions : undefined;
    }

    // --- explicit per-function decompilation ---
    function cachedPseudo(moduleName: string, functionEntry: string): GhidraDecompile | undefined {
        version();
        const m = deps.modules().find((x) => x.name === moduleName);
        const meta = m ? metadataCache.get(fingerprint(m)) : undefined;
        return meta ? pseudoCache.get(`${meta.analysisId}:${functionEntry.toLowerCase()}`) : undefined;
    }

    async function decompileFunction(moduleName: string, functionEntry: string): Promise<{ ok: boolean; error?: string; cached?: boolean }> {
        if (!available()) return { ok: false, error: "decompiler.ghidra is not available" };
        if (!isValidFunctionEntry(functionEntry)) return { ok: false, error: "invalid function entry" };
        const m = deps.modules().find((x) => x.name === moduleName);
        const meta = m ? metadataCache.get(fingerprint(m)) : undefined;
        if (!meta) return { ok: false, error: "run module analysis first" };

        const key = `${meta.analysisId}:${functionEntry.toLowerCase()}`;
        if (pseudoCache.has(key)) {
            emit(evt(TimelineEventType.DecompileCacheHit, "debug", `Ghidra: pseudocode cache hit for ${functionEntry}`, { module: moduleName, functionEntry }));
            return { ok: true, cached: true };
        }
        // Dedup identical in-flight requests.
        const existingP = inflight.get(key);
        const gen = deps.targetSession.generation();
        setDecompileBusy(functionEntry);
        emit(evt(TimelineEventType.DecompileStarted, "info", `Ghidra: decompiling ${functionEntry}…`, { module: moduleName, functionEntry }));

        const run =
            existingP ??
            deps.transport.decompile(deps.config(), { analysisId: meta.analysisId, moduleFingerprint: m ? fingerprint(m) : "", functionEntry, targetGeneration: deps.targetSession.generation() });
        if (!existingP) inflight.set(key, run);

        try {
            const res = await run;
            if (deps.targetSession.isStale(gen)) {
                emit(evt(TimelineEventType.DecompileCancelled, "notice", `Ghidra: decompile discarded (target changed)`, { module: moduleName, functionEntry }));
                return { ok: false, error: "target changed during decompile" };
            }
            if (!res.ok || !res.result) return failDecompile(res.error ?? "decompile failed", moduleName, functionEntry);
            const parsed = parseGhidraDecompile(res.result);
            pseudoCache.set(key, parsed);
            bump((n) => n + 1);
            emit(evt(TimelineEventType.DecompileCompleted, "info", `Ghidra: decompiled ${functionEntry}${parsed.timedOut ? " (timed out)" : ""}`, { module: moduleName, functionEntry, timedOut: parsed.timedOut, truncated: parsed.truncated, durationMs: res.durationMs }));
            return { ok: true };
        } catch (e) {
            return failDecompile(e instanceof Error ? e.message : String(e), moduleName, functionEntry);
        } finally {
            inflight.delete(key);
            setDecompileBusy(undefined);
        }
    }

    function failDecompile(message: string, moduleName: string, functionEntry: string): { ok: false; error: string } {
        setLastError(message);
        emit(evt(TimelineEventType.DecompileFailed, "warning", `Ghidra decompile failed for ${functionEntry}: ${message}`, { module: moduleName, functionEntry, error: message }));
        return { ok: false, error: message };
    }

    // A target-generation change makes live mapping stale but keeps the static caches (dump-derived).
    createEffect(on(deps.targetSession.generation, () => bump((n) => n + 1), { defer: true }));

    return {
        available,
        sidecarState,
        jobState,
        lastError,
        decompileBusy,
        analyzeModule,
        metadata,
        decompileFunction,
        cachedPseudo,
        clearMetadata: () => { metadataCache.clear(); pseudoCache.clear(); bump((n) => n + 1); },
        clearPseudo: (moduleName: string, functionEntry: string) => {
            const m = deps.modules().find((x) => x.name === moduleName);
            const meta = m ? metadataCache.get(fingerprint(m)) : undefined;
            if (meta) pseudoCache.delete(`${meta.analysisId}:${functionEntry.toLowerCase()}`);
            bump((n) => n + 1);
        },
    };
}

export type DecompilerStore = ReturnType<typeof createDecompilerStore>;
