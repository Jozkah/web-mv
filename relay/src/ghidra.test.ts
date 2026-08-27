// Relay-side Ghidra lifecycle tests (Phase 15.3). Runs with `bun test` — NO Ghidra install required:
// the process boundary is replaced through the `__setSpawn` seam with a controllable fake that writes
// the post-script's output file exactly as real Ghidra would, so timeout, per-analysis serialization,
// deduplication, and LRU eviction are all exercised deterministically. These are STATIC-behaviour tests
// of the relay orchestration; they are NOT evidence that a real Ghidra decompiles anything.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __analysisIds,
    __chainCount,
    __hasAnalysis,
    __reset,
    __setMaxAnalyses,
    __setSpawn,
    _analysisCount,
    analyze,
    decompile,
    isValidFunctionEntry,
    probe,
    type GhidraConfig,
    type SpawnedProc,
    type SpawnImpl,
} from "./ghidra";

const ANALYSIS_JSON = JSON.stringify({ format: "web-mv.ghidra.analysis", schemaVersion: 1, imageBase: "0x140000000", functions: [{ address: "0x140001000", name: "main" }], symbols: [] });
const DECOMPILE_JSON = JSON.stringify({ format: "web-mv.ghidra.decompile", schemaVersion: 1, functionEntry: "0x140001000", functionName: "main", cText: "int main(){}", warnings: [], timedOut: false, truncated: false, found: true });

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

let scratch: string;

function makeConfig(over?: Partial<GhidraConfig>): { cfg: GhidraConfig; dumpName: string } {
    scratch = mkdtempSync(join(tmpdir(), "webmv-ghidra-test-"));
    const exe = join(scratch, "analyzeHeadless.bat");
    writeFileSync(exe, "@echo off");
    const dumpDir = join(scratch, "dmp");
    mkdirSync(dumpDir);
    const dumpName = "game.exe_dump.bin";
    writeFileSync(join(dumpDir, dumpName), "MZ" + "\0".repeat(64));
    const projectDir = join(scratch, "proj");
    mkdirSync(projectDir);
    const cfg: GhidraConfig = {
        enabled: true,
        analyzeHeadlessPath: exe,
        dumpDirectory: dumpDir,
        projectDirectory: projectDir,
        defaultTimeoutMs: 5000,
        maxDumpBytes: 64 * 1024 * 1024,
        maxOutputBytes: 16 * 1024 * 1024,
        ...over,
    };
    return { cfg, dumpName };
}

// Controllable fake process. Writes the post-script outfile (argv position after "-postScript" +2)
// with a fixture, exactly as real Ghidra would. Modes cover happy path, gating (for concurrency),
// spawn failure, timeout (never exits until killed), and oversize output.
function controllableSpawn() {
    const calls: string[][] = [];
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];
    let mode: "ok" | "gate" | "throw" | "timeout" | "oversize" = "ok";
    let oversizeBytes = 0;

    function outfileOf(argv: string[]): string {
        const i = argv.indexOf("-postScript");
        const p = i >= 0 ? argv[i + 2] : undefined;
        if (!p) throw new Error("test fake: no outfile in argv");
        return p;
    }
    function contentFor(argv: string[]): string {
        if (mode === "oversize") return "x".repeat(oversizeBytes);
        return argv.includes("export_analysis.py") ? ANALYSIS_JSON : DECOMPILE_JSON;
    }

    const impl: SpawnImpl = (argv) => {
        calls.push(argv);
        if (mode === "throw") throw new Error("spawn failed");
        active++;
        maxActive = Math.max(maxActive, active);
        let resolveExit!: (n: number) => void;
        const exited = new Promise<number>((r) => (resolveExit = r));
        const finish = (code: number, write: boolean) => {
            if (write) writeFileSync(outfileOf(argv), contentFor(argv));
            active--;
            resolveExit(code);
        };
        const proc: SpawnedProc = { exited, kill: () => finish(-1, false), stderr: null };
        if (mode === "timeout") {
            /* never finishes on its own — waits for kill() */
        } else if (mode === "gate") {
            gates.push(() => finish(0, true));
        } else {
            queueMicrotask(() => finish(0, true));
        }
        return proc;
    };

    return {
        impl,
        calls,
        maxActive: () => maxActive,
        pending: () => gates.length,
        release: () => gates.shift()?.(),
        setMode: (m: typeof mode) => (mode = m),
        setOversize: (n: number) => {
            mode = "oversize";
            oversizeBytes = n;
        },
    };
}

afterEach(() => {
    __reset();
    __setSpawn(null);
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe("isValidFunctionEntry", () => {
    test("accepts only plain hex, rejects names and injection", () => {
        expect(isValidFunctionEntry("0x140001000")).toBe(true);
        expect(isValidFunctionEntry("0xABCDEF")).toBe(true);
        expect(isValidFunctionEntry("main")).toBe(false);
        expect(isValidFunctionEntry("0x1000; rm -rf /")).toBe(false);
        expect(isValidFunctionEntry("0x1000 && calc.exe")).toBe(false);
        expect(isValidFunctionEntry("../etc/passwd")).toBe(false);
        expect(isValidFunctionEntry("0x")).toBe(false);
        expect(isValidFunctionEntry("0x" + "f".repeat(17))).toBe(false); // > 16 hex digits
    });
});

describe("probe", () => {
    test("unconfigured / missing / valid", () => {
        expect(probe({ analyzeHeadlessPath: "" } as GhidraConfig).pathValid).toBe(false);
        expect(probe({ analyzeHeadlessPath: "C:/nope/does-not-exist.bat" } as GhidraConfig).pathValid).toBe(false);
        const { cfg } = makeConfig();
        expect(probe(cfg).pathValid).toBe(true);
    });
});

describe("analyze — dump path validation", () => {
    test("rejects traversal, separators, empty, and missing dumpDirectory", async () => {
        const { cfg } = makeConfig();
        for (const bad of ["../secret", "..\\secret", "sub/dir", "sub\\dir", "", "   "]) {
            const r = await analyze(cfg, { dumpFile: bad, base: "0x0" });
            expect(r.ok).toBe(false);
            expect(r.error).toContain("dump filename invalid");
        }
        const noDir = await analyze({ ...cfg, dumpDirectory: undefined }, { dumpFile: "game.exe_dump.bin", base: "0x0" });
        expect(noDir.ok).toBe(false);
    });

    test("rejects a dump larger than maxDumpBytes", async () => {
        const { cfg, dumpName } = makeConfig({ maxDumpBytes: 4 });
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        const r = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        expect(r.ok).toBe(false);
        expect(r.error).toContain("exceeds maxDumpBytes");
        expect(sp.calls.length).toBe(0); // never spawned
    });
});

describe("analyze — happy path & argv discipline", () => {
    test("spawns argv array (no shell) and registers an analysis", async () => {
        const { cfg, dumpName } = makeConfig();
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        const r = await analyze(cfg, { dumpFile: dumpName, base: "0x7ff600000000" });
        expect(r.ok).toBe(true);
        expect(r.analysisId).toBeTruthy();
        expect(r.export).toBe(ANALYSIS_JSON);
        expect(_analysisCount()).toBe(1);

        const argv = sp.calls[0]!;
        expect(Array.isArray(argv)).toBe(true);
        expect(argv[0]).toBe(cfg.analyzeHeadlessPath);
        expect(argv).toContain("-import");
        expect(argv).toContain("PeLoader");
        expect(argv).toContain("export_analysis.py");
        // No element is a shell-joined command string.
        expect(argv.some((a) => a.includes("&&") || a.includes(";") || a.includes("|"))).toBe(false);
    });

    test("two analyses get distinct ids and project names (collision resistance)", async () => {
        const { cfg, dumpName } = makeConfig();
        __setSpawn(controllableSpawn().impl);
        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        const b = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        expect(a.analysisId).not.toBe(b.analysisId);
        expect(_analysisCount()).toBe(2);
    });
});

describe("decompile — validation", () => {
    test("rejects invalid entry and unknown analysisId without spawning", async () => {
        const { cfg } = makeConfig();
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        expect((await decompile(cfg, { analysisId: "an_x", functionEntry: "main" })).ok).toBe(false);
        expect((await decompile(cfg, { analysisId: "nope", functionEntry: "0x140001000" })).ok).toBe(false);
        expect(sp.calls.length).toBe(0);
    });

    test("decompiles one function and returns bounded raw JSON", async () => {
        const { cfg, dumpName } = makeConfig();
        __setSpawn(controllableSpawn().impl);
        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        const r = await decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" });
        expect(r.ok).toBe(true);
        expect(r.result).toBe(DECOMPILE_JSON);
    });

    test("decompile argv reopens with -process -noanalysis, never -import", async () => {
        const { cfg, dumpName } = makeConfig();
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        await decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" });
        const argv = sp.calls[1]!;
        expect(argv).toContain("-process");
        expect(argv).toContain("-noanalysis");
        expect(argv).toContain("decompile_function.py");
        expect(argv).not.toContain("-import");
        expect(argv[argv.length - 1]).toBe("0x140001000"); // exact validated entry, last arg
    });
});

describe("decompile — dedup & serialization", () => {
    test("identical concurrent requests share one spawn", async () => {
        const { cfg, dumpName } = makeConfig();
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        const spawnsBefore = sp.calls.length;
        const [r1, r2] = await Promise.all([
            decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" }),
            decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" }),
        ]);
        expect(r1.ok && r2.ok).toBe(true);
        expect(sp.calls.length - spawnsBefore).toBe(1); // deduplicated
    });

    test("different functions of one analysis run sequentially (max concurrency 1)", async () => {
        const { cfg, dumpName } = makeConfig();
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        sp.setMode("gate");
        const p1 = decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" });
        const p2 = decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140002000" });
        await tick();
        expect(sp.pending()).toBe(1); // only the first is running; second is queued behind the lock
        sp.release();
        await tick();
        expect(sp.pending()).toBe(1); // now the second is running
        sp.release();
        await Promise.all([p1, p2]);
        expect(sp.maxActive()).toBe(1); // never two Ghidra processes on one project at once
    });

    test("different analyses run independently (concurrency 2)", async () => {
        const { cfg, dumpName } = makeConfig();
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        const b = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        sp.setMode("gate");
        const p1 = decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" });
        const p2 = decompile(cfg, { analysisId: b.analysisId!, functionEntry: "0x140001000" });
        await tick();
        expect(sp.pending()).toBe(2);
        expect(sp.maxActive()).toBe(2);
        sp.release();
        sp.release();
        await Promise.all([p1, p2]);
    });
});

describe("eviction — LRU, in-use protection, exact deletion", () => {
    test("an analysis with an in-flight decompile is never evicted; its project files survive", async () => {
        const { cfg, dumpName } = makeConfig();
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        __setMaxAnalyses(1);

        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        // Real project files for A that a running decompile would be reading.
        const aName = `webmv_${a.analysisId}`;
        const aGpr = join(cfg.projectDirectory!, `${aName}.gpr`);
        writeFileSync(aGpr, "project");

        sp.setMode("gate");
        const dec = decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" });
        await tick(); // A has a running (gated) decompile → in use

        sp.setMode("ok");
        const b = await analyze(cfg, { dumpFile: dumpName, base: "0x0" }); // size 2 > cap 1
        // A is protected (in use), so the free newcomer B is the victim — A's files are untouched.
        expect(__hasAnalysis(a.analysisId!)).toBe(true);
        expect(__hasAnalysis(b.analysisId!)).toBe(false);
        expect(existsSync(aGpr)).toBe(true); // NOT deleted mid-decompile

        sp.setMode("gate");
        sp.release();
        const r = await dec;
        expect(r.ok).toBe(true);
    });

    test("evicts the least-recently-used FREE analysis (monotonic LRU)", async () => {
        const { cfg, dumpName } = makeConfig();
        __setSpawn(controllableSpawn().impl);
        __setMaxAnalyses(2);

        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" }); // lastUsed 1
        const b = await analyze(cfg, { dumpFile: dumpName, base: "0x0" }); // lastUsed 2
        await decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" }); // bumps A -> 3
        // Now B is the least-recently-used. Adding C must evict B, not A.
        const c = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        expect(_analysisCount()).toBe(2);
        expect(__hasAnalysis(a.analysisId!)).toBe(true);
        expect(__hasAnalysis(b.analysisId!)).toBe(false);
        expect(__hasAnalysis(c.analysisId!)).toBe(true);
        // The evicted analysis's serialization chain is dropped too (no unbounded growth).
        expect(__chainCount()).toBeLessThanOrEqual(_analysisCount());
        expect(__analysisIds().sort()).toEqual([a.analysisId!, c.analysisId!].sort());
    });

    test("deletes exactly the victim's .gpr file and .rep dir, nothing else", async () => {
        const { cfg, dumpName } = makeConfig();
        __setSpawn(controllableSpawn().impl);
        __setMaxAnalyses(1);

        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        const victimName = `webmv_${a.analysisId}`;
        const gpr = join(cfg.projectDirectory!, `${victimName}.gpr`);
        const rep = join(cfg.projectDirectory!, `${victimName}.rep`);
        const bystander = join(cfg.projectDirectory!, "keep-me.txt");
        writeFileSync(gpr, "project");
        mkdirSync(rep);
        writeFileSync(join(rep, "inner"), "data");
        writeFileSync(bystander, "unrelated");

        await analyze(cfg, { dumpFile: dumpName, base: "0x0" }); // evicts A

        expect(existsSync(gpr)).toBe(false);
        expect(existsSync(rep)).toBe(false);
        expect(existsSync(bystander)).toBe(true); // untouched
    });
});

describe("failure modes — no poisoned locks, structured errors, capacity intact", () => {
    test("spawn failure returns a structured error and does not block the next job", async () => {
        const { cfg, dumpName } = makeConfig();
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        sp.setMode("throw");
        const bad = await decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" });
        expect(bad.ok).toBe(false);
        expect(bad.error).toContain("failed to spawn");
        sp.setMode("ok");
        const good = await decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140002000" });
        expect(good.ok).toBe(true); // lock not poisoned by the earlier failure
    });

    test("timeout kills the child and returns a structured error, lock released", async () => {
        const { cfg, dumpName } = makeConfig({ defaultTimeoutMs: 15 });
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        sp.setMode("timeout");
        const timed = await decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" });
        expect(timed.ok).toBe(false);
        expect(timed.error).toContain("no output"); // killed before writing the outfile
        sp.setMode("ok");
        const ok = await decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" });
        expect(ok.ok).toBe(true); // released, retryable
        expect(_analysisCount()).toBe(1);
    });

    test("captures a stderr tail while draining concurrently (no pipe-buffer deadlock)", async () => {
        const { cfg, dumpName } = makeConfig();
        // A child whose stderr must be drained: `exited` resolves independently, and the runner must read
        // stderr concurrently rather than only after exit (the deadlock this guards against).
        __setSpawn((argv) => {
            const i = argv.indexOf("-postScript");
            writeFileSync(argv[i + 2]!, ANALYSIS_JSON);
            const stderr = new ReadableStream<Uint8Array>({
                start(c) { c.enqueue(new TextEncoder().encode("WARN: Ghidra verbose ".repeat(100))); c.close(); },
            });
            return { exited: Promise.resolve(0), kill: () => {}, stderr };
        });
        const r = await analyze(cfg, { dumpFile: dumpName, base: "0x0" });
        expect(r.ok).toBe(true);
        expect(r.stderrTail).toContain("WARN");
    });

    test("oversize output is rejected by the byte bound", async () => {
        const { cfg, dumpName } = makeConfig({ maxOutputBytes: 1024 });
        const sp = controllableSpawn();
        __setSpawn(sp.impl);
        const a = await analyze(cfg, { dumpFile: dumpName, base: "0x0" }); // metadata JSON well under 1 KiB
        sp.setOversize(4096);
        const r = await decompile(cfg, { analysisId: a.analysisId!, functionEntry: "0x140001000" });
        expect(r.ok).toBe(false);
        expect(r.error).toContain("exceeds limit");
    });
});
