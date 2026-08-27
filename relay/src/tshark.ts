import { existsSync, realpathSync, statSync } from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

// Optional local tshark (Wireshark CLI) adapter — OFFLINE PCAP analysis only. It NEVER captures live
// packets and is completely unrelated to Angel: Angel has no packet-capture primitive, and these
// packets are NOT correlated to the attached target (no PID/socket ownership is available). Nothing is
// downloaded or bundled — the user supplies a local tshark install and its absolute path via config.
//
// Every spawn uses an argv ARRAY (never a shell string). The frontend never supplies command-line
// flags: it sends typed fields (a bare pcap filename, an integer frame/stream, or a display-filter
// expression) that this module translates into an ALLOWLISTED argv. `-n` is always passed so tshark
// performs no name resolution (no DNS / network egress), and `-r` (read file) is always used — `-i`
// (live capture) is never constructed here. Output is bounded by bytes, packet count, and a timeout.

export interface TsharkConfig {
    enabled: boolean;
    tsharkPath: string; // absolute path to tshark(.exe)
    pcapDirectory?: string; // guarded directory the relay reads .pcap/.pcapng files from (bare filename only)
    workspaceDirectory?: string; // reserved for future extracted-object jobs; unused today (stdout only)
    defaultTimeoutMs: number;
    maxCaptureBytes: number; // reject a pcap larger than this before running
    maxOutputBytes: number; // bound tshark stdout
    maxPackets: number; // `-c` cap on packets read
}

export interface ProbeResult {
    ok: boolean;
    pathValid: boolean; // executable exists
    runnable: boolean; // `tshark --version` ran and looked like tshark
    version?: string;
    error?: string;
}

export type PcapOp = "summary" | "filter" | "dissect" | "follow";

export interface AnalyzeJob {
    pcapFile: string; // BARE filename resolved under config.pcapDirectory
    op: PcapOp;
    displayFilter?: string; // for op "summary"/"filter": a tshark DISPLAY filter (never a shell arg)
    frameNumber?: number; // for op "dissect": the one packet to fully dissect (+ raw bytes)
    streamType?: "tcp" | "udp"; // for op "follow"
    streamIndex?: number; // for op "follow"
    timeoutMs?: number;
}

export interface AnalyzeResult {
    ok: boolean;
    op?: PcapOp;
    stdout?: string; // bounded raw tshark output — parsed + validated at the frontend boundary
    truncated?: boolean; // output hit maxOutputBytes
    packetCap?: number; // the -c cap applied (so the UI can say "first N")
    captureBytes?: number;
    captureHash?: string; // sha256 of the capture file (op "summary" only) — stable content identity
    format?: "pcap" | "pcapng"; // from magic validation
    error?: string;
    exitCode?: number;
    stderrTail?: string;
    durationMs: number;
}

// sha256 of a capture file, streamed so a large capture is not fully buffered. Only computed on import
// (op "summary") — it is the stable identity a project bundle keys annotations to.
async function hashFile(path: string): Promise<string> {
    const h = createHash("sha256");
    for await (const chunk of Bun.file(path).stream()) h.update(chunk as Uint8Array);
    return h.digest("hex");
}

// --- Spawn seam (tests inject a fake; the real one spawns tshark) -----------------------------------
export interface SpawnedProc {
    exited: Promise<number>;
    kill(): void;
    stdout?: ReadableStream | number | null;
    stderr?: ReadableStream | number | null;
}
export type SpawnImpl = (cmd: string[]) => SpawnedProc;
const defaultSpawn: SpawnImpl = (cmd) => Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as unknown as SpawnedProc;
let spawnImpl: SpawnImpl = defaultSpawn;

// Bounded concurrency: tshark is memory-hungry on large captures; cap simultaneous jobs.
let maxConcurrent = 3;
let inFlight = 0;

// The allowlisted per-packet columns for summary/filter output. This list is fixed in code — the
// frontend can NEVER add a field. `-E occurrence=f` keeps each cell single-valued.
// `_ws.col.Info` is free text and is the one field that can itself contain the tab separator, so it is
// LAST — the frontend parser treats everything after the final expected tab as Info. Order here is the
// column order in the output header.
const SUMMARY_FIELDS: readonly string[] = [
    "frame.number",
    "frame.time_epoch",
    "frame.len",
    "frame.cap_len",
    "frame.protocols",
    "ip.src",
    "ipv6.src",
    "ip.dst",
    "ipv6.dst",
    "_ws.col.Protocol",
    "tcp.srcport",
    "tcp.dstport",
    "udp.srcport",
    "udp.dstport",
    "tcp.stream",
    "udp.stream",
    "dns.qry.name",
    "http.request.method",
    "http.host",
    "http.request.uri",
    "http.response.code",
    "tls.handshake.type",
    "tls.handshake.extensions_server_name",
    "websocket.opcode",
    "_ws.expert.severity",
    "_ws.col.Info",
];

export function probeArgs(): string[] {
    return ["--version"];
}

// A tshark display filter is passed as ONE argv token after `-Y`, so it can never be parsed as another
// option or a shell command. We still bound it and reject control characters and a leading dash (which
// some getopt variants could mis-split), so only a plausible filter expression is ever forwarded.
export function isValidDisplayFilter(f: string): boolean {
    if (f.length === 0 || f.length > 512) return false;
    if (f.startsWith("-")) return false;
    // No NUL / newline / other control chars.
    for (let i = 0; i < f.length; i++) {
        const c = f.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return false;
    }
    return true;
}

export function isValidStreamIndex(n: unknown): n is number {
    return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1_000_000;
}
export function isValidFrameNumber(n: unknown): n is number {
    return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 100_000_000;
}

export function resolvePcapPath(cfg: TsharkConfig, pcapFile: string): string | null {
    if (!cfg.pcapDirectory) return null;
    const clean = normalize(pcapFile);
    if (clean.includes("/") || clean.includes("\\") || clean.includes("..") || clean.trim() === "") return null;
    const dir = resolve(cfg.pcapDirectory);
    const full = resolve(dir, clean);
    if (!full.startsWith(dir + sep)) return null;
    // Reject a symlink that escapes the directory (realpath must still be inside it).
    try {
        const real = realpathSync(full);
        const realDir = realpathSync(dir);
        if (real !== realDir && !real.startsWith(realDir + sep)) return null;
        return real;
    } catch {
        return null; // does not exist / not resolvable
    }
}

// Validate the file is actually a pcap/pcapng by MAGIC BYTES (never trust the extension) and reject a
// gzip-compressed capture (a decompression-bomb vector). Returns a reason string on rejection.
export function validatePcapMagic(path: string): { ok: boolean; format?: "pcap" | "pcapng"; error?: string } {
    let fd = -1;
    try {
        fd = openSync(path, "r");
        const buf = Buffer.alloc(4);
        const n = readSync(fd, buf, 0, 4, 0);
        if (n < 4) return { ok: false, error: "file too small to be a capture" };
        const m = buf.readUInt32BE(0);
        const mLE = buf.readUInt32LE(0);
        // gzip magic 0x1f8b — refuse compressed captures (bomb risk; require plain pcap/pcapng).
        if (buf[0] === 0x1f && buf[1] === 0x8b) return { ok: false, error: "compressed captures are not accepted (decompress first)" };
        // pcapng section header block starts with 0x0A0D0D0A.
        if (m === 0x0a0d0d0a) return { ok: true, format: "pcapng" };
        // classic pcap magic (either endianness), incl. the nanosecond variant.
        if (m === 0xa1b2c3d4 || mLE === 0xa1b2c3d4 || m === 0xa1b23c4d || mLE === 0xa1b23c4d) return { ok: true, format: "pcap" };
        return { ok: false, error: "not a pcap/pcapng file (bad magic)" };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
        if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ }
    }
}

export function probe(cfg: TsharkConfig): ProbeResult {
    const p = cfg.tsharkPath?.trim();
    if (!p) return { ok: false, pathValid: false, runnable: false, error: "tshark path not configured" };
    if (!existsSync(p)) return { ok: false, pathValid: false, runnable: false, error: `tshark not found at ${p}` };
    return { ok: true, pathValid: true, runnable: false }; // runnable is proven by probeRun(), not by existence
}

async function readBoundedStream(stream: ReadableStream | number | null | undefined, maxBytes: number, onLimit?: () => void): Promise<{ text: string; truncated: boolean }> {
    if (!stream || typeof stream === "number") return { text: "", truncated: false };
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            if (total + value.byteLength > maxBytes) {
                const room = Math.max(0, maxBytes - total);
                if (room > 0) chunks.push(value.subarray(0, room));
                total += room;
                truncated = true;
                // Kill the producer: once we stop draining, it would block writing the rest and never
                // exit. Killing lets `exited` resolve so the job completes.
                onLimit?.();
                break;
            }
            chunks.push(value);
            total += value.byteLength;
        }
    } finally {
        try { await reader.cancel(); } catch { /* ignore */ }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { text: buf.toString("utf8"), truncated };
}

async function run(cfg: TsharkConfig, args: string[], timeoutMs: number): Promise<{ exitCode: number; stdout: string; truncated: boolean; stderrTail: string }> {
    const proc = spawnImpl([cfg.tsharkPath, ...args]);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* exited */ } }, timeoutMs);
    try {
        // Drain stdout/stderr CONCURRENTLY with waiting for exit. Awaiting exit first would deadlock on
        // a large capture: tshark blocks writing once the pipe buffer fills and never exits until read.
        const [out, err, exitCode] = await Promise.all([
            readBoundedStream(proc.stdout, cfg.maxOutputBytes, () => { try { proc.kill(); } catch { /* exited */ } }),
            readBoundedStream(proc.stderr, 4096),
            proc.exited,
        ]);
        return { exitCode: timedOut ? -1 : exitCode, stdout: out.text, truncated: out.truncated, stderrTail: err.text.slice(-2000) };
    } finally {
        clearTimeout(timer);
    }
}

// Proves the configured tshark actually runs (bounded preflight → `runnable`). Never touches a pcap.
export async function probeRun(cfg: TsharkConfig): Promise<ProbeResult> {
    const base = probe(cfg);
    if (!base.pathValid) return base;
    try {
        const r = await run(cfg, probeArgs(), Math.min(cfg.defaultTimeoutMs, 15000));
        const line = r.stdout.split(/\r?\n/, 1)[0] ?? "";
        const m = /(?:TShark|Wireshark)\b.*?(\d+\.\d+\.\d+)/i.exec(r.stdout);
        if (m) return { ok: true, pathValid: true, runnable: true, version: m[1] };
        return { ok: false, pathValid: true, runnable: false, error: `unexpected --version output: ${line.slice(0, 120)}` };
    } catch (e) {
        return { ok: false, pathValid: true, runnable: false, error: e instanceof Error ? e.message : String(e) };
    }
}

function buildArgs(cfg: TsharkConfig, job: AnalyzeJob, pcap: string): { args: string[] } | { error: string } {
    const fieldArgs = SUMMARY_FIELDS.flatMap((f) => ["-e", f]);
    const commonSummary = ["-T", "fields", ...fieldArgs, "-E", "header=y", "-E", "separator=\t", "-E", "occurrence=f"];
    switch (job.op) {
        case "summary":
            return { args: ["-r", pcap, "-n", "-c", String(cfg.maxPackets), ...commonSummary] };
        case "filter": {
            const f = job.displayFilter ?? "";
            if (!isValidDisplayFilter(f)) return { error: "invalid display filter" };
            return { args: ["-r", pcap, "-n", "-Y", f, "-c", String(cfg.maxPackets), ...commonSummary] };
        }
        case "dissect": {
            if (!isValidFrameNumber(job.frameNumber)) return { error: "invalid frame number" };
            // One packet: full protocol tree (-T json) plus raw bytes (-x). Raw bytes only here, never
            // for the whole capture.
            return { args: ["-r", pcap, "-n", "-Y", `frame.number==${job.frameNumber}`, "-T", "json", "-x"] };
        }
        case "follow": {
            if (job.streamType !== "tcp" && job.streamType !== "udp") return { error: "invalid stream type" };
            if (!isValidStreamIndex(job.streamIndex)) return { error: "invalid stream index" };
            return { args: ["-r", pcap, "-n", "-q", "-z", `follow,${job.streamType},raw,${job.streamIndex}`] };
        }
    }
}

export async function analyze(cfg: TsharkConfig, job: AnalyzeJob): Promise<AnalyzeResult> {
    const started = Date.now();
    const dur = () => Date.now() - started;

    const pr = probe(cfg);
    if (!pr.pathValid) return { ok: false, error: pr.error, durationMs: dur() };

    const pcap = resolvePcapPath(cfg, job.pcapFile);
    if (!pcap) return { ok: false, error: "pcap filename invalid or pcapDirectory not configured", durationMs: dur() };

    let captureBytes = 0;
    try {
        const st = statSync(pcap);
        if (!st.isFile()) return { ok: false, error: "pcap path is not a regular file", durationMs: dur() };
        captureBytes = st.size;
    } catch {
        return { ok: false, error: "pcap file not found under pcapDirectory", durationMs: dur() };
    }
    if (captureBytes > cfg.maxCaptureBytes) return { ok: false, error: `capture ${captureBytes} bytes exceeds maxCaptureBytes`, durationMs: dur() };

    const magic = validatePcapMagic(pcap);
    if (!magic.ok) return { ok: false, error: magic.error, captureBytes, durationMs: dur() };

    const built = buildArgs(cfg, job, pcap);
    if ("error" in built) return { ok: false, error: built.error, captureBytes, durationMs: dur() };

    if (inFlight >= maxConcurrent) return { ok: false, error: "tshark busy (too many concurrent jobs)", captureBytes, durationMs: dur() };

    const timeoutMs = Math.min(cfg.defaultTimeoutMs, job.timeoutMs ?? cfg.defaultTimeoutMs);
    inFlight++;
    try {
        const r = await run(cfg, built.args, timeoutMs);
        if (r.exitCode !== 0 && r.stdout.trim() === "") {
            return { ok: false, op: job.op, error: r.exitCode === -1 ? "tshark timed out" : `tshark exited ${r.exitCode}`, exitCode: r.exitCode, stderrTail: r.stderrTail, captureBytes, durationMs: dur() };
        }
        // Content identity is established at import (summary); other ops run against the same file.
        const captureHash = job.op === "summary" ? await hashFile(pcap) : undefined;
        return { ok: true, op: job.op, stdout: r.stdout, truncated: r.truncated, packetCap: cfg.maxPackets, captureBytes, captureHash, format: magic.format, exitCode: r.exitCode, stderrTail: r.stderrTail, durationMs: dur() };
    } catch (e) {
        return { ok: false, op: job.op, error: `failed to spawn tshark: ${e instanceof Error ? e.message : String(e)}`, captureBytes, durationMs: dur() };
    } finally {
        inFlight--;
    }
}

// --- Test-only helpers (never imported by index.ts) ------------------------------------------------
export function __setSpawn(fn: SpawnImpl | null): void {
    spawnImpl = fn ?? defaultSpawn;
}
export function __setMaxConcurrent(n: number): void {
    maxConcurrent = n;
}
export function __inFlight(): number {
    return inFlight;
}
export function __reset(): void {
    spawnImpl = defaultSpawn;
    maxConcurrent = 3;
    inFlight = 0;
}
