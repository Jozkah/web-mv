import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, normalize, resolve, sep } from "node:path";

// Optional local Ghidra headless runner (relay side). Ghidra performs STATIC analysis of an
// Angel-obtained dump — it never attaches to, reads, or writes the target process; Angel remains the
// process/memory foundation. Nothing here is downloaded or bundled: the user supplies a local Ghidra
// install and its path via config. Every spawn uses an argv ARRAY (never a shell string), reads the
// dump from a path-traversal-guarded location, and bounds timeout + dump size + output size.
//
// Two distinct operations (Phase 15.1):
//   analyze()  — auto-analyze + export METADATA only (no decompiler). Keeps a bounded persistent
//                Ghidra project so a later decompile can reopen the already-analyzed program.
//   decompile()— reopen the cached project and decompile EXACTLY ONE function on explicit request.

export interface GhidraConfig {
    enabled: boolean;
    analyzeHeadlessPath: string;
    projectDirectory?: string;
    dumpDirectory?: string;
    defaultTimeoutMs: number;
    maxDumpBytes: number;
    maxOutputBytes: number;
}

export interface AnalyzeJob {
    dumpFile: string; // BARE filename resolved under config.dumpDirectory
    base: string; // live module base (hex) — informational; mapping is frontend-side
    processor?: string;
    timeoutMs?: number;
}

export interface ProbeResult {
    ok: boolean; // path exists (pathValid) — NOT proof of working analysis
    pathValid: boolean;
    path?: string;
    error?: string;
}

export interface AnalyzeResult {
    ok: boolean;
    analysisId?: string;
    export?: string; // raw analysis JSON (bounded)
    error?: string;
    exitCode?: number;
    stderrTail?: string;
    durationMs: number;
}

export interface DecompileJob {
    analysisId: string;
    functionEntry: string; // hex, e.g. "0x140001000"
    timeoutMs?: number;
}

export interface DecompileResult {
    ok: boolean;
    result?: string; // raw single-function JSON (bounded)
    error?: string;
    exitCode?: number;
    stderrTail?: string;
    durationMs: number;
}

// Server-side analysis registry so decompile never accepts a dump/project/script path from the
// frontend — only an opaque analysisId + a validated function entry.
interface AnalysisEntry {
    projectDir: string;
    projectName: string;
    programName: string; // Ghidra program name = imported dump basename
    processor?: string;
    createdAt: number; // wall-clock, informational only
    lastUsed: number; // MONOTONIC logical clock (++useSeq), not wall-clock: eviction is LRU by touch
    // order. A wall-clock lastUsed has coarse (ms) resolution and can move backwards (NTP), which makes
    // "least recently used" ambiguous or wrong; a strictly-increasing counter is unambiguous.
}
let maxAnalyses = 16;
let useSeq = 0;
const analyses = new Map<string, AnalysisEntry>();
const inflightDecompile = new Map<string, Promise<DecompileResult>>();
// One Ghidra process per analysis project at a time: two concurrent `analyzeHeadless -process` on the
// same project would collide on Ghidra's project lock, so decompiles for one analysis are serialized.
const analysisChain = new Map<string, Promise<unknown>>();

// Spawn seam: the real runner spawns Ghidra; tests inject a fake to exercise timeout/serialization/
// eviction deterministically without a Ghidra install. The seam is the ONLY process boundary.
export interface SpawnedProc {
    exited: Promise<number>;
    kill(): void;
    stderr?: ReadableStream | number | null;
}
export type SpawnImpl = (cmd: string[]) => SpawnedProc;
// stdout is IGNORED (not piped): Ghidra is chatty on stdout, and an unread stdout pipe fills and blocks
// the child so it never exits. The analysis result is written to a FILE, not stdout, so we need none of
// it. stderr is piped and drained concurrently (below) for a bounded diagnostic tail.
const defaultSpawn: SpawnImpl = (cmd) => Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" }) as unknown as SpawnedProc;
let spawnImpl: SpawnImpl = defaultSpawn;

function withAnalysisLock<T>(analysisId: string, fn: () => Promise<T>): Promise<T> {
    const prev = analysisChain.get(analysisId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run after the previous job settles (success or failure)
    analysisChain.set(
        analysisId,
        next.then(
            () => undefined,
            () => undefined,
        ),
    );
    return next;
}

// Whether any decompile is queued or running against an analysis (its project must not be evicted).
function analysisInUse(analysisId: string): boolean {
    for (const key of inflightDecompile.keys()) if (key.startsWith(`${analysisId}:`)) return true;
    return false;
}

function scriptDir(): string {
    const here = (import.meta as unknown as { dir?: string }).dir ?? process.cwd();
    return resolve(here, "..", "ghidra");
}

export function probe(cfg: GhidraConfig): ProbeResult {
    const p = cfg.analyzeHeadlessPath?.trim();
    if (!p) return { ok: false, pathValid: false, error: "analyzeHeadless path not configured" };
    if (!existsSync(p)) return { ok: false, pathValid: false, error: `analyzeHeadless not found at ${p}` };
    return { ok: true, pathValid: true, path: p };
}

function resolveDumpPath(cfg: GhidraConfig, dumpFile: string): string | null {
    if (!cfg.dumpDirectory) return null;
    const clean = normalize(dumpFile);
    if (clean.includes("/") || clean.includes("\\") || clean.includes("..") || clean.trim() === "") return null;
    const dir = resolve(cfg.dumpDirectory);
    const full = resolve(dir, clean);
    if (full !== join(dir, clean) || !full.startsWith(dir + sep)) return null;
    return full;
}

// Only a plain hex address is ever accepted as a decompile target — never a name or command fragment.
export function isValidFunctionEntry(entry: string): boolean {
    return /^0x[0-9a-f]{1,16}$/i.test(entry.trim());
}

function projectBase(): string {
    return process.env.GHIDRA_PROJECTS ?? tmpdir();
}

// Delete a persistent project we created (guarded to our naming — never a broad cleanup).
function deleteProject(dir: string, name: string): void {
    try {
        rmSync(join(dir, `${name}.gpr`), { force: true });
        rmSync(join(dir, `${name}.rep`), { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
}

function evictAnalyses(): void {
    while (analyses.size > maxAnalyses) {
        // Evict the least-recently-used analysis, but NEVER one with a queued/running decompile — its
        // project files are still being read, so deleting them would corrupt the in-flight job.
        let victimId: string | undefined;
        let oldest = Infinity;
        for (const [id, a] of analyses) {
            if (analysisInUse(id)) continue;
            if (a.lastUsed < oldest) { oldest = a.lastUsed; victimId = id; }
        }
        if (!victimId) break; // all remaining analyses are in use — leave the cap slightly over
        const a = analyses.get(victimId)!;
        deleteProject(a.projectDir, a.projectName);
        analyses.delete(victimId);
        // The victim has no in-flight decompile (in-use analyses are skipped above), so its serialization
        // chain has settled and can be dropped — otherwise analysisChain grows without bound across a long
        // session (one stale resolved promise per analysisId ever seen).
        analysisChain.delete(victimId);
    }
}

async function readBoundedOutput(outFile: string, maxBytes: number): Promise<{ text?: string; error?: string }> {
    if (!existsSync(outFile)) return { error: "no output produced (analysis failed or timed out)" };
    const size = Bun.file(outFile).size;
    if (size > maxBytes) return { error: `output ${size} bytes exceeds limit ${maxBytes}` };
    return { text: await Bun.file(outFile).text() };
}

async function runHeadless(cfg: GhidraConfig, args: string[], timeoutMs: number): Promise<{ exitCode: number; stderrTail: string }> {
    const proc = spawnImpl([cfg.analyzeHeadlessPath, ...args]);
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* exited */ } }, timeoutMs);
    try {
        // Drain stderr CONCURRENTLY with waiting for exit — awaiting exit first would deadlock if Ghidra
        // writes more than the stderr pipe buffer holds (it blocks on the write and never exits).
        const err = proc.stderr;
        const errP = err && typeof err !== "number" ? new Response(err as ReadableStream).text() : Promise.resolve("");
        const [exitCode, errText] = await Promise.all([proc.exited, errP]);
        return { exitCode, stderrTail: errText.slice(-2000) };
    } finally {
        clearTimeout(timer);
    }
}

export async function analyze(cfg: GhidraConfig, job: AnalyzeJob): Promise<AnalyzeResult> {
    const started = Date.now();
    const dur = () => Date.now() - started;

    const pr = probe(cfg);
    if (!pr.ok) return { ok: false, error: pr.error, durationMs: dur() };

    const dump = resolveDumpPath(cfg, job.dumpFile);
    if (!dump) return { ok: false, error: "dump filename invalid or dumpDirectory not configured", durationMs: dur() };
    if (!existsSync(dump)) return { ok: false, error: "dump file not found under dumpDirectory", durationMs: dur() };
    const dumpSize = Bun.file(dump).size;
    if (dumpSize > cfg.maxDumpBytes) return { ok: false, error: `dump ${dumpSize} bytes exceeds maxDumpBytes`, durationMs: dur() };

    const timeoutMs = Math.min(cfg.defaultTimeoutMs, job.timeoutMs ?? cfg.defaultTimeoutMs);
    const projectDir = cfg.projectDirectory && cfg.projectDirectory.trim() !== "" ? cfg.projectDirectory : projectBase();
    const analysisId = `an_${Date.now()}_${Math.floor(Bun.nanoseconds() % 1e9)}`;
    const projectName = `webmv_${analysisId}`;
    const outFile = join(tmpdir(), `web-mv-ghidra-analysis-${analysisId}.json`);

    // Auto-analyze (finds functions) + export METADATA. Persist the project so decompile can reopen it.
    const args = [
        projectDir,
        projectName,
        "-import",
        dump,
        "-loader",
        "PeLoader",
        ...(job.processor ? ["-processor", job.processor] : []),
        "-scriptPath",
        scriptDir(),
        "-postScript",
        "export_analysis.py",
        outFile,
        "-analysisTimeoutPerFile",
        String(Math.ceil(timeoutMs / 1000)),
    ];

    let run: { exitCode: number; stderrTail: string };
    try {
        run = await runHeadless(cfg, args, timeoutMs);
    } catch (e) {
        return { ok: false, error: `failed to spawn analyzeHeadless: ${e instanceof Error ? e.message : String(e)}`, durationMs: dur() };
    }

    const out = await readBoundedOutput(outFile, cfg.maxOutputBytes);
    if (out.error) {
        deleteProject(projectDir, projectName);
        return { ok: false, error: out.error, exitCode: run.exitCode, stderrTail: run.stderrTail, durationMs: dur() };
    }

    analyses.set(analysisId, { projectDir, projectName, programName: basename(dump), processor: job.processor, createdAt: Date.now(), lastUsed: ++useSeq });
    evictAnalyses();
    return { ok: true, analysisId, export: out.text, exitCode: run.exitCode, stderrTail: run.stderrTail, durationMs: dur() };
}

export async function decompile(cfg: GhidraConfig, job: DecompileJob): Promise<DecompileResult> {
    const started = Date.now();
    const dur = () => Date.now() - started;

    const pr = probe(cfg);
    if (!pr.ok) return { ok: false, error: pr.error, durationMs: dur() };
    if (!isValidFunctionEntry(job.functionEntry)) return { ok: false, error: "invalid function entry", durationMs: dur() };
    const entry = analyses.get(job.analysisId);
    if (!entry) return { ok: false, error: "unknown analysisId (re-run module analysis)", durationMs: dur() };

    // Deduplicate identical in-flight requests (one decompile per function).
    const key = `${job.analysisId}:${job.functionEntry.toLowerCase()}`;
    const existing = inflightDecompile.get(key);
    if (existing) return existing;

    // INVARIANT: no `await` between `analyses.get` above and `inflightDecompile.set` below. Keeping this
    // window synchronous is what guarantees the analysis is marked in-use before any other async work
    // (an analyze()'s evictAnalyses) can observe it — so its project can never be evicted mid-decompile.
    // Serialize per analysis (one Ghidra process per project at a time) and mark the analysis in use
    // (via inflightDecompile) so eviction cannot delete its project mid-decompile.
    const promise = withAnalysisLock(job.analysisId, async (): Promise<DecompileResult> => {
        entry.lastUsed = ++useSeq;
        const timeoutMs = Math.min(cfg.defaultTimeoutMs, job.timeoutMs ?? cfg.defaultTimeoutMs);
        const outFile = join(tmpdir(), `web-mv-ghidra-decompile-${Date.now()}.json`);
        // Reopen the already-analyzed program (-process), skip re-analysis, decompile one function.
        const args = [
            entry.projectDir,
            entry.projectName,
            "-process",
            entry.programName,
            "-noanalysis",
            "-scriptPath",
            scriptDir(),
            "-postScript",
            "decompile_function.py",
            outFile,
            job.functionEntry,
        ];
        let run: { exitCode: number; stderrTail: string };
        try {
            run = await runHeadless(cfg, args, timeoutMs);
        } catch (e) {
            return { ok: false, error: `failed to spawn analyzeHeadless: ${e instanceof Error ? e.message : String(e)}`, durationMs: dur() };
        }
        const out = await readBoundedOutput(outFile, cfg.maxOutputBytes);
        if (out.error) return { ok: false, error: out.error, exitCode: run.exitCode, stderrTail: run.stderrTail, durationMs: dur() };
        return { ok: true, result: out.text, exitCode: run.exitCode, stderrTail: run.stderrTail, durationMs: dur() };
    });

    inflightDecompile.set(key, promise);
    try {
        return await promise;
    } finally {
        inflightDecompile.delete(key);
        // Reclaim now that this job is done: if the cap was exceeded while analyses were in use, the
        // over-cap entries persist until something calls evictAnalyses() again. Do it here so capacity
        // returns to the bound as soon as jobs finish, not only on the next analyze().
        evictAnalyses();
    }
}

// Test/introspection helpers (not exposed over HTTP; never imported by index.ts).
export function _analysisCount(): number {
    return analyses.size;
}
export function __setSpawn(fn: SpawnImpl | null): void {
    spawnImpl = fn ?? defaultSpawn;
}
export function __setMaxAnalyses(n: number): void {
    maxAnalyses = n;
}
export function __reset(): void {
    analyses.clear();
    inflightDecompile.clear();
    analysisChain.clear();
    maxAnalyses = 16;
    useSeq = 0;
}
export function __analysisIds(): string[] {
    return [...analyses.keys()];
}
export function __hasAnalysis(id: string): boolean {
    return analyses.has(id);
}
export function __chainCount(): number {
    return analysisChain.size;
}
