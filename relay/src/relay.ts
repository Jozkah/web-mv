import type { ServerWebSocket, WebSocketHandler } from "bun";

// The relay forwards raw frames between any number of browser UI tabs and the single agent
// (Echo host). On top of that pipe it multiplexes stateless HTTP callers (POST /rpc - see index.ts)
// onto that same agent: every request carries an echoed integer `id`, so replies can be routed back.
//
// UI clients generate unique request IDs (prefixed per tab instance). Agent responses for UI
// are broadcasted to all connected UI browser tabs, where each tab matches its own pending request
// by ID and ignores non-matching frames.

export type Role = "ui" | "agent" | "agent-ext";

export interface SocketData {
    role: Role;
}

// Verbs handled by the extension agent (write-family: memory mutation, dump, PE table walks,
// value/raw scans, resource tree, IAT rebuild). Everything else goes to the core agent (Echo's
// built-in memory server via process::open_socket). The two run as separate agent sockets because
// a single Angel host cannot expose Echo's built-in server and a custom ws:: handler on the same
// relay endpoint. Routing by verb here keeps the proven read/scan/disassemble path untouched while
// adding mutation support. Keep this in sync with web_mv_ext_agent.as's dispatch — a mismatch means
// a verb silently times out on the wrong socket.
const EXT_VERBS = new Set<string>([
    "write",
    "dump",
    "exports",
    "imports",
    "iat_rebuild",
    "sections",
    "regions",
    "scan_new",
    "scan_filter",
    "scan_clear",
    "scan_grouped",
    "raw_scan",
    "pe_header",
    "pe_dirs",
    "resource_tree",
    // Unicorn emulator verb family (create/run/step/registers/memory/reset/close).
    "emulate",
    // Capability handshake: the ext agent is the source of truth for which verbs it implements.
    "capabilities",
]);

function frameType(message: string | Buffer): string | undefined {
    let obj: unknown;
    try {
        obj = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
    } catch {
        return undefined;
    }
    const type = (obj as { type?: unknown })?.type;
    return typeof type === "string" ? type : undefined;
}

const uiSockets = new Set<ServerWebSocket<SocketData>>();
let agent: ServerWebSocket<SocketData> | null = null;
let agentExt: ServerWebSocket<SocketData> | null = null;

/** Pick the agent socket that should service a frame of the given verb. */
function agentFor(type: string | undefined): ServerWebSocket<SocketData> | null {
    if (type !== undefined && EXT_VERBS.has(type)) return agentExt;
    return agent;
}

/** Whether the core agent (Echo built-in server) is connected. */
export function agentConnected(): boolean {
    return agent !== null;
}

/** Whether the extension agent (write/dump/exports/sections) is connected. */
export function extConnected(): boolean {
    return agentExt !== null;
}

// --- RPC multiplexer state -------------------------------------------------

// RPC ids live far above anything the frontend's AxClient will ever reach, so the two lanes
// never collide on a shared agent socket.
const RPC_ID_BASE = 0x40000000; // 1,073,741,824

// Whole-module results (enumerate, scans) arrive as tens-of-MB frames. RPC is meant
// for point reads and other small ops, so any agent frame larger than this is a UI-lane result.
const RPC_MAX_REPLY_BYTES = 8 * 1024 * 1024;

interface RpcPending {
    resolve: (frame: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    sock: ServerWebSocket<SocketData>; // the agent lane this call was sent to
}

const rpcPending = new Map<number, RpcPending>();
let rpcNextId = 1;

/**
 * Send a protocol frame to the agent on behalf of a stateless HTTP caller and resolve
 * with the agent's raw JSON reply.
 */
export function callAgent(frame: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const sock = agentFor(typeof frame.type === "string" ? frame.type : undefined);
    if (!sock) return Promise.reject(new Error("no agent connected"));

    const id = RPC_ID_BASE + rpcNextId++;
    if (rpcNextId >= RPC_ID_BASE) rpcNextId = 1;

    const payload = JSON.stringify({ ...frame, id });
    return new Promise<string>((resolve, reject) => {
        sock.send(payload);
        const timer = setTimeout(() => {
            rpcPending.delete(id);
            reject(new Error("agent request timed out"));
        }, timeoutMs);
        rpcPending.set(id, { resolve, reject, timer, sock });
    });
}

/** Reject only the pending /rpc calls that were routed to `sock` (the lane that just dropped). */
function rejectRpcFor(sock: ServerWebSocket<SocketData>, err: Error): void {
    for (const [id, p] of rpcPending) {
        if (p.sock !== sock) continue;
        clearTimeout(p.timer);
        rpcPending.delete(id);
        p.reject(err);
    }
}

// --- Active-client tracking (drives the UI's "agents" badge) ----------------
const CLIENT_TTL_MS = 15_000;
const lastSeen = new Map<string, number>();

export function noteClient(id: string): void {
    lastSeen.set(id, Date.now());
}

/** Distinct clients seen within CLIENT_TTL_MS. Prunes stale entries as it counts. */
export function activeAgentCount(): number {
    const cutoff = Date.now() - CLIENT_TTL_MS;
    let n = 0;
    for (const [id, ts] of lastSeen) {
        if (ts >= cutoff) n++;
        else lastSeen.delete(id);
    }
    return n;
}

function frameByteLength(message: string | Buffer): number {
    return typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
}

/** Best-effort id extraction from a small agent frame. Returns undefined if absent. */
function readFrameId(message: string | Buffer): number | undefined {
    let obj: unknown;
    try {
        obj = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
    } catch {
        return undefined;
    }
    const id = (obj as { id?: unknown })?.id;
    return typeof id === "number" ? id : undefined;
}

/**
 * Route a frame from the agent. If it belongs to a pending RPC call, resolve that call.
 * Otherwise forward to all connected browser UI clients.
 */
function routeAgentFrame(message: string | Buffer): void {
    // Always check for pending RPC replies by frame ID when there are outstanding requests.
    // The size check is only a fast-path: if a frame is large and has no matching RPC id,
    // it's a UI-lane result. Previously, oversized RPC replies would skip id-matching entirely,
    // causing the HTTP caller to hang and UI tabs to receive unexpected frames.
    if (rpcPending.size > 0) {
        const id = readFrameId(message);
        if (id !== undefined && id >= RPC_ID_BASE) {
            const p = rpcPending.get(id);
            if (p) {
                clearTimeout(p.timer);
                rpcPending.delete(id);
                p.resolve(typeof message === "string" ? message : message.toString("utf8"));
                return;
            }
        }
    }
    for (const client of uiSockets) {
        client.send(message);
    }
}

export const handlers: WebSocketHandler<SocketData> = {
    maxPayloadLength: 256 * 1024 * 1024,
    backpressureLimit: 256 * 1024 * 1024,
    idleTimeout: 300,

    open(ws) {
        if (ws.data.role === "ui") {
            uiSockets.add(ws);
            console.log(`[+] ui connected (total: ${uiSockets.size})`);
        } else if (ws.data.role === "agent-ext") {
            agentExt?.close(1000, "replaced by newer ext agent");
            agentExt = ws;
            console.log(`[+] ext agent connected (write/dump/exports/scan/pe/resource)`);
        } else {
            agent?.close(1000, "replaced by newer agent");
            agent = ws;
            console.log(`[+] agent connected`);
        }
    },

    message(ws, message) {
        // Both agent sockets funnel replies through the same RPC-match/broadcast path.
        if (ws.data.role === "agent" || ws.data.role === "agent-ext") {
            routeAgentFrame(message);
        } else {
            // UI request: route to the agent that owns this verb (ext for write-family).
            agentFor(frameType(message))?.send(message);
        }
    },

    close(ws, code, reason) {
        if (ws.data.role === "ui") {
            uiSockets.delete(ws);
            console.log(`[-] ui disconnected (code ${code}, remaining: ${uiSockets.size})`);
        }
        if (ws.data.role === "agent-ext" && agentExt === ws) {
            agentExt = null;
            rejectRpcFor(ws, new Error("ext agent disconnected"));
            console.log(`[-] ext agent disconnected (code ${code}${reason ? `, ${reason}` : ""})`);
        }
        if (ws.data.role === "agent" && agent === ws) {
            agent = null;
            rejectRpcFor(ws, new Error("agent disconnected"));
            console.log(`[-] agent disconnected (code ${code}${reason ? `, ${reason}` : ""})`);
        }
    },
};
