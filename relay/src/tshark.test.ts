// Relay-side tshark adapter tests (Priority 2). Runs with `bun test` — NO tshark install required:
// the process boundary is replaced through the `__setSpawn` seam with a fake that emits fixture stdout.
// These prove argv allowlisting, injection/traversal resistance, pcap-magic validation, bounds,
// concurrency, and timeout — NOT that a real tshark dissects anything (that needs a real install).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __inFlight,
    __reset,
    __setMaxConcurrent,
    __setSpawn,
    analyze,
    isValidDisplayFilter,
    isValidFrameNumber,
    isValidStreamIndex,
    probe,
    probeRun,
    resolvePcapPath,
    validatePcapMagic,
    type SpawnedProc,
    type SpawnImpl,
    type TsharkConfig,
} from "./tshark";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

let scratch: string;

function streamOf(text: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(bytes);
            c.close();
        },
    });
}

// A minimal real file with valid classic-pcap big-endian magic (A1 B2 C3 D4), padded to 24 bytes.
function writePcap(path: string): void {
    const buf = Buffer.alloc(24);
    buf[0] = 0xa1;
    buf[1] = 0xb2;
    buf[2] = 0xc3;
    buf[3] = 0xd4;
    writeFileSync(path, buf);
}

function makeConfig(over?: Partial<TsharkConfig>): { cfg: TsharkConfig; pcapName: string } {
    scratch = mkdtempSync(join(tmpdir(), "webmv-tshark-test-"));
    const exe = join(scratch, "tshark.exe");
    writeFileSync(exe, "binary");
    const pcapDir = join(scratch, "caps");
    mkdirSync(pcapDir);
    const pcapName = "sample.pcapng";
    writePcap(join(pcapDir, pcapName));
    const cfg: TsharkConfig = {
        enabled: true,
        tsharkPath: exe,
        pcapDirectory: pcapDir,
        defaultTimeoutMs: 5000,
        maxCaptureBytes: 100 * 1024 * 1024,
        maxOutputBytes: 8 * 1024 * 1024,
        maxPackets: 5000,
        ...over,
    };
    return { cfg, pcapName };
}

// Controllable fake tshark. Records argv; emits fixture stdout; supports version/big/timeout/gate.
function fakeSpawn() {
    const calls: string[][] = [];
    let mode: "ok" | "version" | "big" | "timeout" | "gate" = "ok";
    let stdoutText = "frame.number\tframe.len\n1\t74\n";
    const gates: Array<() => void> = [];

    const impl: SpawnImpl = (argv) => {
        calls.push(argv);
        let resolveExit!: (n: number) => void;
        const exited = new Promise<number>((r) => (resolveExit = r));
        let text = stdoutText;
        if (mode === "version") text = "TShark (Wireshark) 4.2.0 (v4.2.0-0)\nCopyright ...\n";
        else if (mode === "big") text = "x".repeat(64 * 1024);

        if (mode === "timeout") {
            // stdout closes immediately (like a killed child's pipe) but the process never exits on its
            // own — only the timeout's kill() resolves `exited`.
            const proc: SpawnedProc = { exited, kill: () => resolveExit(-1), stdout: streamOf(""), stderr: null };
            return proc;
        }
        if (mode === "gate") {
            let ctrl!: ReadableStreamDefaultController<Uint8Array>;
            const stdout = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
            gates.push(() => { ctrl.enqueue(new TextEncoder().encode(text)); ctrl.close(); resolveExit(0); });
            return { exited, kill: () => resolveExit(-1), stdout, stderr: null };
        }
        queueMicrotask(() => resolveExit(0));
        return { exited, kill: () => resolveExit(-1), stdout: streamOf(text), stderr: null };
    };

    return {
        impl,
        calls,
        setMode: (m: typeof mode) => (mode = m),
        setStdout: (t: string) => (stdoutText = t),
        release: () => gates.shift()?.(),
        pending: () => gates.length,
    };
}

afterEach(() => {
    __reset();
    if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
});

describe("input validators", () => {
    test("display filter allows expressions, rejects injection vectors", () => {
        expect(isValidDisplayFilter("tcp.port == 443")).toBe(true);
        expect(isValidDisplayFilter("http.request and ip.addr==10.0.0.1")).toBe(true);
        expect(isValidDisplayFilter("")).toBe(false);
        expect(isValidDisplayFilter("-r /etc/passwd")).toBe(false); // leading dash
        expect(isValidDisplayFilter("tcp\nport")).toBe(false); // newline
        expect(isValidDisplayFilter("x".repeat(513))).toBe(false); // too long
    });
    test("stream index and frame number bounds", () => {
        expect(isValidStreamIndex(0)).toBe(true);
        expect(isValidStreamIndex(-1)).toBe(false);
        expect(isValidStreamIndex(1.5)).toBe(false);
        expect(isValidFrameNumber(1)).toBe(true);
        expect(isValidFrameNumber(0)).toBe(false);
        expect(isValidFrameNumber("1" as unknown)).toBe(false);
    });
});

describe("resolvePcapPath", () => {
    test("rejects traversal / separators, resolves a bare filename", () => {
        const { cfg, pcapName } = makeConfig();
        for (const bad of ["../x", "..\\x", "a/b", "a\\b", "", "..", "nope.pcap"]) {
            expect(resolvePcapPath(cfg, bad)).toBeNull();
        }
        expect(resolvePcapPath(cfg, pcapName)).not.toBeNull();
        expect(resolvePcapPath({ ...cfg, pcapDirectory: undefined }, pcapName)).toBeNull();
    });
});

describe("validatePcapMagic", () => {
    test("accepts pcap/pcapng, rejects gzip, junk, and tiny files", () => {
        const dir = mkdtempSync(join(tmpdir(), "webmv-magic-"));
        try {
            const pcapBE = join(dir, "be.pcap");
            writeFileSync(pcapBE, Buffer.from([0xa1, 0xb2, 0xc3, 0xd4, 0, 0]));
            expect(validatePcapMagic(pcapBE).ok).toBe(true);
            const pcapLE = join(dir, "le.pcap");
            writeFileSync(pcapLE, Buffer.from([0xd4, 0xc3, 0xb2, 0xa1, 0, 0]));
            expect(validatePcapMagic(pcapLE).ok).toBe(true);
            const png = join(dir, "ng.pcapng");
            writeFileSync(png, Buffer.from([0x0a, 0x0d, 0x0d, 0x0a, 0, 0]));
            expect(validatePcapMagic(png).format).toBe("pcapng");
            const gz = join(dir, "c.pcap.gz");
            writeFileSync(gz, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
            expect(validatePcapMagic(gz).ok).toBe(false);
            const junk = join(dir, "j.pcap");
            writeFileSync(junk, Buffer.from([1, 2, 3, 4]));
            expect(validatePcapMagic(junk).ok).toBe(false);
            const tiny = join(dir, "t.pcap");
            writeFileSync(tiny, Buffer.from([1]));
            expect(validatePcapMagic(tiny).ok).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("probe / probeRun", () => {
    test("probe reports pathValid but never runnable from existence alone", () => {
        expect(probe({ tsharkPath: "" } as TsharkConfig).pathValid).toBe(false);
        const { cfg } = makeConfig();
        const p = probe(cfg);
        expect(p.pathValid).toBe(true);
        expect(p.runnable).toBe(false);
    });
    test("probeRun proves runnable from --version output", async () => {
        const { cfg } = makeConfig();
        const sp = fakeSpawn();
        sp.setMode("version");
        __setSpawn(sp.impl);
        const r = await probeRun(cfg);
        expect(r.runnable).toBe(true);
        expect(r.version).toBe("4.2.0");
        expect(sp.calls[0]).toEqual([cfg.tsharkPath, "--version"]);
    });
    test("probeRun rejects unexpected --version output", async () => {
        const { cfg } = makeConfig();
        const sp = fakeSpawn();
        sp.setMode("ok");
        sp.setStdout("not tshark at all");
        __setSpawn(sp.impl);
        const r = await probeRun(cfg);
        expect(r.runnable).toBe(false);
    });
});

describe("analyze — argv discipline & offline safety", () => {
    test("summary builds an allowlisted argv: -r, -n, -c, -T fields; never -i", async () => {
        const { cfg, pcapName } = makeConfig();
        const sp = fakeSpawn();
        __setSpawn(sp.impl);
        const r = await analyze(cfg, { pcapFile: pcapName, op: "summary" });
        expect(r.ok).toBe(true);
        expect(r.stdout).toContain("frame.number");
        const argv = sp.calls[0]!;
        expect(argv[0]).toBe(cfg.tsharkPath);
        expect(argv).toContain("-r");
        expect(argv).toContain("-n"); // no name resolution → no DNS/network
        expect(argv).toContain("-T");
        expect(argv).toContain("fields");
        expect(argv).toContain("-c");
        expect(argv).not.toContain("-i"); // never live capture
        expect(argv.some((a) => a.includes("&&") || a.includes(";") || a.includes("|") || a.includes("`"))).toBe(false);
    });

    test("summary returns a stable content hash + format; other ops do not hash", async () => {
        const { cfg, pcapName } = makeConfig();
        __setSpawn(fakeSpawn().impl);
        const s = await analyze(cfg, { pcapFile: pcapName, op: "summary" });
        expect(s.ok).toBe(true);
        expect(s.captureHash).toMatch(/^[0-9a-f]{64}$/); // sha256
        expect(s.format).toBe("pcap"); // writePcap wrote classic BE magic
        const again = await analyze(cfg, { pcapFile: pcapName, op: "summary" });
        expect(again.captureHash).toBe(s.captureHash); // deterministic for the same file
        const f = await analyze(cfg, { pcapFile: pcapName, op: "filter", displayFilter: "tcp" });
        expect(f.captureHash).toBeUndefined(); // identity established at import only
    });

    test("filter forwards a validated display filter as one -Y token; rejects an invalid one", async () => {
        const { cfg, pcapName } = makeConfig();
        const sp = fakeSpawn();
        __setSpawn(sp.impl);
        const ok = await analyze(cfg, { pcapFile: pcapName, op: "filter", displayFilter: "tcp.port==443" });
        expect(ok.ok).toBe(true);
        const argv = sp.calls[0]!;
        const yi = argv.indexOf("-Y");
        expect(yi).toBeGreaterThan(-1);
        expect(argv[yi + 1]).toBe("tcp.port==443");

        const bad = await analyze(cfg, { pcapFile: pcapName, op: "filter", displayFilter: "-r x" });
        expect(bad.ok).toBe(false);
        expect(sp.calls.length).toBe(1); // invalid filter never spawned
    });

    test("dissect requires a valid frame number and requests raw bytes only for that packet", async () => {
        const { cfg, pcapName } = makeConfig();
        const sp = fakeSpawn();
        sp.setStdout("[]");
        __setSpawn(sp.impl);
        expect((await analyze(cfg, { pcapFile: pcapName, op: "dissect" })).ok).toBe(false);
        expect(sp.calls.length).toBe(0);
        const r = await analyze(cfg, { pcapFile: pcapName, op: "dissect", frameNumber: 3 });
        expect(r.ok).toBe(true);
        const argv = sp.calls[0]!;
        expect(argv).toContain("-x"); // raw bytes
        expect(argv).toContain("json");
        expect(argv.some((a) => a === "frame.number==3")).toBe(true);
    });

    test("follow requires a valid stream type + index", async () => {
        const { cfg, pcapName } = makeConfig();
        const sp = fakeSpawn();
        sp.setStdout("===stream===");
        __setSpawn(sp.impl);
        expect((await analyze(cfg, { pcapFile: pcapName, op: "follow", streamType: "tcp" })).ok).toBe(false);
        expect((await analyze(cfg, { pcapFile: pcapName, op: "follow", streamType: "icmp" as unknown as "tcp", streamIndex: 0 })).ok).toBe(false);
        const r = await analyze(cfg, { pcapFile: pcapName, op: "follow", streamType: "udp", streamIndex: 2 });
        expect(r.ok).toBe(true);
        expect(sp.calls[0]!.some((a) => a === "follow,udp,raw,2")).toBe(true);
    });
});

describe("analyze — input rejection", () => {
    test("bad pcap name, missing file, oversize capture, bad magic", async () => {
        const { cfg, pcapName } = makeConfig({ maxCaptureBytes: 8 });
        __setSpawn(fakeSpawn().impl);
        expect((await analyze(cfg, { pcapFile: "../x", op: "summary" })).ok).toBe(false);
        expect((await analyze(cfg, { pcapFile: "ghost.pcap", op: "summary" })).ok).toBe(false);
        const big = await analyze(cfg, { pcapFile: pcapName, op: "summary" }); // 24 bytes > 8
        expect(big.ok).toBe(false);
        expect(big.error).toContain("exceeds maxCaptureBytes");
    });

    test("a file with a non-capture magic is rejected before spawning", async () => {
        const { cfg } = makeConfig();
        const junk = "junk.pcap";
        writeFileSync(join(cfg.pcapDirectory!, junk), Buffer.from([0, 1, 2, 3, 4, 5]));
        const sp = fakeSpawn();
        __setSpawn(sp.impl);
        const r = await analyze(cfg, { pcapFile: junk, op: "summary" });
        expect(r.ok).toBe(false);
        expect(sp.calls.length).toBe(0);
    });
});

describe("analyze — bounds, concurrency, timeout", () => {
    test("stdout is truncated at maxOutputBytes", async () => {
        const { cfg, pcapName } = makeConfig({ maxOutputBytes: 1024 });
        const sp = fakeSpawn();
        sp.setMode("big"); // 64 KiB
        __setSpawn(sp.impl);
        const r = await analyze(cfg, { pcapFile: pcapName, op: "summary" });
        expect(r.ok).toBe(true);
        expect(r.truncated).toBe(true);
        expect(r.stdout!.length).toBeLessThanOrEqual(1024);
    });

    test("concurrent jobs beyond the cap are rejected as busy", async () => {
        const { cfg, pcapName } = makeConfig();
        const sp = fakeSpawn();
        sp.setMode("gate");
        __setSpawn(sp.impl);
        __setMaxConcurrent(1);
        const p1 = analyze(cfg, { pcapFile: pcapName, op: "summary" });
        await tick();
        expect(__inFlight()).toBe(1);
        const busy = await analyze(cfg, { pcapFile: pcapName, op: "summary" });
        expect(busy.ok).toBe(false);
        expect(busy.error).toContain("busy");
        sp.release();
        await p1;
        expect(__inFlight()).toBe(0);
    });

    test("timeout kills tshark and returns a structured error", async () => {
        const { cfg, pcapName } = makeConfig({ defaultTimeoutMs: 15 });
        const sp = fakeSpawn();
        sp.setMode("timeout");
        __setSpawn(sp.impl);
        const r = await analyze(cfg, { pcapFile: pcapName, op: "summary" });
        expect(r.ok).toBe(false);
        expect(r.error).toContain("timed out");
        expect(__inFlight()).toBe(0);
    });
});
