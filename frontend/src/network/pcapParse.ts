import { z } from "zod";

// Pure parsers for tshark OFFLINE output. The relay returns bounded raw tshark stdout; everything here
// validates and normalizes it at the frontend boundary. NONE of this implies live capture or any link
// to the attached Angel target — it is dissection of a capture file the user already had.
//
// Honesty: these packets carry no process identity. There is no PID/socket ownership in a pcap, so the
// UI must never claim a packet belongs to the attached target. Timestamps are the capture's own.

export const PCAP_SCHEMA_VERSION = 1 as const;

// Column order MUST match relay SUMMARY_FIELDS (tshark `-T fields`). `_ws.col.Info` is last because it
// is free text that may itself contain the tab separator — everything after the last expected tab is Info.
export const SUMMARY_COLUMNS = [
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
] as const;

export interface PacketSummary {
    number: number;
    timeEpoch?: number;
    len?: number;
    capLen?: number;
    protocols?: string;
    src?: string;
    dst?: string;
    protocol?: string;
    srcPort?: number;
    dstPort?: number;
    tcpStream?: number;
    udpStream?: number;
    dns?: string;
    httpMethod?: string;
    httpHost?: string;
    httpUri?: string;
    httpStatus?: string;
    tlsHandshakeType?: string;
    tlsSni?: string;
    wsOpcode?: string;
    expertSeverity?: string;
    info?: string;
}

export interface CaptureMetadata {
    schemaVersion: typeof PCAP_SCHEMA_VERSION;
    packetCount: number;
    firstEpoch?: number;
    lastEpoch?: number;
    durationSec?: number;
    protocols: string[]; // distinct _ws.col.Protocol values, most-common first
    truncated: boolean; // packet list hit the -c cap or the byte bound
    captureBytes?: number;
}

function num(s: string | undefined): number | undefined {
    if (s === undefined || s.trim() === "") return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
}

// Split a tab row into exactly SUMMARY_COLUMNS.length cells: the first N-1 by successive tabs, and the
// entire remainder (which may contain tabs) as the final Info cell.
function splitRow(line: string, cols: number): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < cols - 1; i++) {
        const t = line.indexOf("\t", start);
        if (t === -1) {
            out.push(line.slice(start));
            start = line.length;
            // pad the rest
            while (out.length < cols) out.push("");
            return out;
        }
        out.push(line.slice(start, t));
        start = t + 1;
    }
    out.push(line.slice(start));
    return out;
}

export function parsePacketSummaries(stdout: string, max = 200000): PacketSummary[] {
    const lines = stdout.split(/\r?\n/);
    if (lines.length === 0) return [];
    // Drop the header row (starts with "frame.number") if present.
    let startIdx = 0;
    if (lines[0]?.startsWith("frame.number")) startIdx = 1;
    const cols = SUMMARY_COLUMNS.length;
    const idx = (name: string) => SUMMARY_COLUMNS.indexOf(name as (typeof SUMMARY_COLUMNS)[number]);
    const packets: PacketSummary[] = [];
    for (let i = startIdx; i < lines.length && packets.length < max; i++) {
        const line = lines[i];
        if (!line || line.trim() === "") continue;
        const c = splitRow(line, cols);
        const number = num(c[idx("frame.number")]);
        if (number === undefined) continue; // not a data row
        packets.push({
            number,
            timeEpoch: num(c[idx("frame.time_epoch")]),
            len: num(c[idx("frame.len")]),
            capLen: num(c[idx("frame.cap_len")]),
            protocols: c[idx("frame.protocols")] || undefined,
            src: c[idx("ip.src")] || c[idx("ipv6.src")] || undefined,
            dst: c[idx("ip.dst")] || c[idx("ipv6.dst")] || undefined,
            protocol: c[idx("_ws.col.Protocol")] || undefined,
            srcPort: num(c[idx("tcp.srcport")]) ?? num(c[idx("udp.srcport")]),
            dstPort: num(c[idx("tcp.dstport")]) ?? num(c[idx("udp.dstport")]),
            tcpStream: num(c[idx("tcp.stream")]),
            udpStream: num(c[idx("udp.stream")]),
            dns: c[idx("dns.qry.name")] || undefined,
            httpMethod: c[idx("http.request.method")] || undefined,
            httpHost: c[idx("http.host")] || undefined,
            httpUri: c[idx("http.request.uri")] || undefined,
            httpStatus: c[idx("http.response.code")] || undefined,
            tlsHandshakeType: c[idx("tls.handshake.type")] || undefined,
            tlsSni: c[idx("tls.handshake.extensions_server_name")] || undefined,
            wsOpcode: c[idx("websocket.opcode")] || undefined,
            expertSeverity: c[idx("_ws.expert.severity")] || undefined,
            info: c[idx("_ws.col.Info")] || undefined,
        });
    }
    return packets;
}

export function deriveMetadata(packets: PacketSummary[], truncated: boolean, captureBytes?: number): CaptureMetadata {
    const epochs = packets.map((p) => p.timeEpoch).filter((e): e is number => e !== undefined);
    const first = epochs.length ? Math.min(...epochs) : undefined;
    const last = epochs.length ? Math.max(...epochs) : undefined;
    const counts = new Map<string, number>();
    for (const p of packets) if (p.protocol) counts.set(p.protocol, (counts.get(p.protocol) ?? 0) + 1);
    const protocols = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return {
        schemaVersion: PCAP_SCHEMA_VERSION,
        packetCount: packets.length,
        firstEpoch: first,
        lastEpoch: last,
        durationSec: first !== undefined && last !== undefined ? last - first : undefined,
        protocols,
        truncated,
        captureBytes,
    };
}

export interface Endpoint {
    address: string;
    packets: number;
    bytes: number;
}

export function deriveEndpoints(packets: PacketSummary[]): Endpoint[] {
    const m = new Map<string, Endpoint>();
    const touch = (addr: string | undefined, bytes: number) => {
        if (!addr) return;
        const e = m.get(addr) ?? { address: addr, packets: 0, bytes: 0 };
        e.packets++;
        e.bytes += bytes;
        m.set(addr, e);
    };
    for (const p of packets) {
        const b = p.len ?? 0;
        touch(p.src, b);
        touch(p.dst, b);
    }
    return [...m.values()].sort((a, b) => b.bytes - a.bytes);
}

export interface Conversation {
    a: string;
    b: string;
    protocol: string; // "TCP" | "UDP" | "other"
    stream?: number;
    packets: number;
    bytes: number;
}

export function deriveConversations(packets: PacketSummary[]): Conversation[] {
    const m = new Map<string, Conversation>();
    for (const p of packets) {
        if (!p.src || !p.dst) continue;
        const isTcp = p.tcpStream !== undefined;
        const isUdp = p.udpStream !== undefined;
        const proto = isTcp ? "TCP" : isUdp ? "UDP" : "other";
        const stream = isTcp ? p.tcpStream : isUdp ? p.udpStream : undefined;
        // Canonical unordered pair so A→B and B→A merge.
        const [a, b] = p.src < p.dst ? [p.src, p.dst] : [p.dst, p.src];
        const key = `${proto}:${stream ?? `${a}|${b}`}`;
        const c = m.get(key) ?? { a, b, protocol: proto, stream, packets: 0, bytes: 0 };
        c.packets++;
        c.bytes += p.len ?? 0;
        m.set(key, c);
    }
    return [...m.values()].sort((a, b) => b.bytes - a.bytes);
}

// --- Follow stream (tshark -z follow,<proto>,raw,<n>) ----------------------------------------------

export interface FollowChunk {
    fromNode: 0 | 1; // 0 = first node (client), 1 = second node (server)
    hex: string;
    bytes: number;
}
export interface FollowStream {
    schemaVersion: typeof PCAP_SCHEMA_VERSION;
    node0?: string;
    node1?: string;
    chunks: FollowChunk[];
    totalBytes: number;
    truncated: boolean;
    // Data-looking lines that could not be parsed as hex. A NON-ZERO value means the result is partial —
    // it is never silently dropped while reporting complete success. Zero with no chunks = a valid empty
    // stream (distinct from a parse failure).
    malformed: number;
}

// Parse `tshark -z follow,<proto>,raw,<n>` output. Tolerant by design: it never throws on odd input,
// bounds bytes BEFORE accumulating, preserves direction from indentation (the raw-mode direction
// marker), lowercases hex, and reports any malformed data lines rather than hiding them. It never infers
// process ownership — a capture has none. Runtime layout across tshark versions remains UNPROVEN.
export function parseFollowStream(stdout: string, maxBytes = 1024 * 1024): FollowStream {
    const lines = stdout.split(/\r?\n/);
    let node0: string | undefined;
    let node1: string | undefined;
    const chunks: FollowChunk[] = [];
    let total = 0;
    let truncated = false;
    let malformed = 0;
    for (const raw of lines) {
        const line = raw;
        const trimmed = line.trim();
        const n0 = /^Node 0:\s*(.+)$/.exec(trimmed);
        const n1 = /^Node 1:\s*(.+)$/.exec(trimmed);
        if (n0) { node0 = n0[1]; continue; }
        if (n1) { node1 = n1[1]; continue; }
        // Header / separator / blank lines are structural, not data — skip without counting malformed.
        if (trimmed === "" || line.startsWith("=") || line.startsWith("Follow:") || line.startsWith("Filter:")) continue;
        // A data line is hex; leading whitespace marks the node 1 → node 0 direction (raw mode).
        const fromNode: 0 | 1 = /^\s/.test(line) ? 1 : 0;
        const hex = trimmed.replace(/\s+/g, "");
        if (hex.length === 0) continue; // blank data line
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) { malformed++; continue; } // odd/invalid hex — reported, not hidden
        const bytes = hex.length / 2;
        // Enforce the byte limit BEFORE allocating the chunk.
        if (total + bytes > maxBytes) { truncated = true; break; }
        total += bytes;
        chunks.push({ fromNode, hex: hex.toLowerCase(), bytes });
    }
    return { schemaVersion: PCAP_SCHEMA_VERSION, node0, node1, chunks, totalBytes: total, truncated, malformed };
}

// --- Single-packet dissection (tshark -T json -x) --------------------------------------------------

const dissectSchema = z.array(
    z.object({
        _source: z.object({
            layers: z.record(z.string(), z.unknown()),
        }),
    }),
);

export interface TreeNode {
    name: string;
    value?: string;
    children: TreeNode[];
}
export interface Dissection {
    schemaVersion: typeof PCAP_SCHEMA_VERSION;
    tree: TreeNode[];
    rawHex?: string;
    truncatedTree: boolean;
}

const MAX_TREE_NODES = 5000;
const MAX_TREE_DEPTH = 24;

export function parseDissection(stdout: string): Dissection {
    const json: unknown = JSON.parse(stdout);
    const arr = dissectSchema.parse(json);
    const first = arr[0];
    if (!first) return { schemaVersion: PCAP_SCHEMA_VERSION, tree: [], truncatedTree: false };
    const layers = first._source.layers;
    let nodeCount = 0;
    let truncated = false;

    const build = (name: string, value: unknown, depth: number): TreeNode | null => {
        if (nodeCount >= MAX_TREE_NODES || depth > MAX_TREE_DEPTH) {
            truncated = true;
            return null;
        }
        nodeCount++;
        if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            return { name, value: String(value), children: [] };
        }
        const node: TreeNode = { name, children: [] };
        if (Array.isArray(value)) {
            // tshark "*_raw" fields are [hex, off, len, ...]; show the hex compactly.
            if (typeof value[0] === "string" && name.endsWith("_raw")) {
                node.value = String(value[0]).slice(0, 512);
                return node;
            }
            value.forEach((v, i) => {
                const child = build(String(i), v, depth + 1);
                if (child) node.children.push(child);
            });
        } else if (typeof value === "object") {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                if (nodeCount >= MAX_TREE_NODES) { truncated = true; break; }
                const child = build(k, v, depth + 1);
                if (child) node.children.push(child);
            }
        }
        return node;
    };

    const tree: TreeNode[] = [];
    for (const [k, v] of Object.entries(layers)) {
        if (k.endsWith("_raw")) continue; // shown as rawHex / inline, not as top-level layers
        const node = build(k, v, 0);
        if (node) tree.push(node);
    }
    const frameRaw = layers["frame_raw"];
    let rawHex: string | undefined;
    if (Array.isArray(frameRaw) && typeof frameRaw[0] === "string") rawHex = frameRaw[0];
    else if (typeof frameRaw === "string") rawHex = frameRaw;

    return { schemaVersion: PCAP_SCHEMA_VERSION, tree, rawHex, truncatedTree: truncated };
}

// Format a raw hex string as an offset/hex/ascii dump (bounded rows for display).
export function hexDump(hex: string, maxBytes = 4096): string[] {
    const clean = hex.replace(/[^0-9a-fA-F]/g, "");
    const bytes: number[] = [];
    for (let i = 0; i + 1 < clean.length && bytes.length < maxBytes; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
    const rows: string[] = [];
    for (let off = 0; off < bytes.length; off += 16) {
        const slice = bytes.slice(off, off + 16);
        const hexPart = slice.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(16 * 3 - 1, " ");
        const ascii = slice.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
        rows.push(`${off.toString(16).padStart(8, "0")}  ${hexPart}  ${ascii}`);
    }
    return rows;
}
