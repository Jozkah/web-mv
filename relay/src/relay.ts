import type { ServerWebSocket, WebSocketHandler } from "bun";

// The relay forwards raw frames between any number of browser UI tabs and the single agent
// (Echo host). On top of that pipe it multiplexes stateless HTTP callers (POST /rpc - see index.ts)
// onto that same agent: every request carries an echoed integer `id`, so replies can be routed back.
//
// UI clients generate unique request IDs (prefixed per tab instance). Agent responses for UI
// are broadcasted to all connected UI browser tabs, where each tab matches its own pending request
// by ID and ignores non-matching frames.

export type Role = "ui" | "agent";

export interface SocketData {
    role: Role;
}

const uiSockets = new Set<ServerWebSocket<SocketData>>();
let agent: ServerWebSocket<SocketData> | null = null;

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
}

const rpcPending = new Map<number, RpcPending>();
let rpcNextId = 1;

/**
 * Send a protocol frame to the agent on behalf of a stateless HTTP caller and resolve
 * with the agent's raw JSON reply.
 */
export function callAgent(frame: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const sock = agent;
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
        rpcPending.set(id, { resolve, reject, timer });
    });
}

function rejectAllRpc(err: Error): void {
    for (const p of rpcPending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
    }
    rpcPending.clear();
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
        } else {
            agent?.close(1000, "replaced by newer agent");
            agent = ws;
            console.log(`[+] agent connected`);
        }
    },

    message(ws, message) {
        if (ws.data.role === "agent") {
            routeAgentFrame(message);
        } else {
            agent?.send(message);
        }
    },

    close(ws, code, reason) {
        if (ws.data.role === "ui") {
            uiSockets.delete(ws);
            console.log(`[-] ui disconnected (code ${code}, remaining: ${uiSockets.size})`);
        }
        if (ws.data.role === "agent" && agent === ws) {
            agent = null;
            rejectAllRpc(new Error("agent disconnected"));
            console.log(`[-] agent disconnected (code ${code}${reason ? `, ${reason}` : ""})`);
        }
    },
};
