import type { ServerWebSocket, WebSocketHandler } from "bun";

// The relay forwards raw frames between the single browser UI and the single agent
// (Echo host). On top of that dumb pipe it multiplexes any number of stateless HTTP
// callers (POST /rpc - see index.ts) onto that same agent: every request carries an
// echoed integer `id`, so replies can be routed back to whoever asked.
//
// The two lanes coexist by partitioning the id space. The browser (AxClient) numbers
// its requests from 1 upward; the relay numbers RPC requests from RPC_ID_BASE upward.
// An agent reply whose id lands in the RPC range resolves a pending HTTP call and is
// NOT forwarded to the UI; anything else is forwarded verbatim (current behaviour).

export type Role = "ui" | "agent";

export interface SocketData {
    role: Role;
}

let ui: ServerWebSocket<SocketData> | null = null;
let agent: ServerWebSocket<SocketData> | null = null;

// --- RPC multiplexer state -------------------------------------------------

// RPC ids live far above anything the frontend's AxClient will ever reach (it counts
// from 1), so the two lanes never collide on a shared agent socket.
const RPC_ID_BASE = 0x40000000; // 1,073,741,824

// Whole-module results (enumerate, scans) arrive as tens-of-MB frames. RPC is meant
// for point reads and other small ops, so any agent frame larger than this is, by
// construction, a UI-lane result - skip parsing it and forward straight to the browser.
// This is a performance guard only: smaller UI replies are still parsed and correctly
// routed to the UI because their id falls below RPC_ID_BASE.
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
 * with the agent's raw JSON reply. Assigns a unique RPC id (overriding any `id` in the
 * caller's frame), parks a promise keyed by that id, and lets the agent `message`
 * handler resolve it when the matching reply arrives.
 */
export function callAgent(frame: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const sock = agent;
    if (!sock) return Promise.reject(new Error("no agent connected"));

    const id = RPC_ID_BASE + rpcNextId++;
    // Wrap rpcNextId so a very long-lived relay never climbs out of the RPC range.
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
// RPC is stateless HTTP, so callers self-identify with an `x-mv-client` header. We keep the
// last-seen time per id and count anyone seen within the TTL as currently active - a chat
// that has gone quiet for longer than this ages out. Date.now is fine here: this is the Bun
// runtime, not a workflow script.
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
 * Route a frame from the agent. If it belongs to a pending RPC call, resolve that call
 * and stop. Otherwise it is a UI-lane reply - forward it to the browser verbatim.
 */
function routeAgentFrame(message: string | Buffer): void {
    if (rpcPending.size > 0 && frameByteLength(message) <= RPC_MAX_REPLY_BYTES) {
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
    ui?.send(message);
}

function peerOf(role: Role): ServerWebSocket<SocketData> | null {
    return role === "ui" ? agent : ui;
}

export const handlers: WebSocketHandler<SocketData> = {
    // Whole-module results (enumerate, scans) on large binaries arrive as a single frame that
    // is tens of MB, far past Bun's 16MB default. Without these raised, Bun closes the sender's
    // socket (close 1009) the moment such a frame arrives - which the agent sees as a reset
    // (websocket_receive failed 0x2efe). backpressureLimit covers forwarding that frame on to a
    // slower peer; idleTimeout is generous since a single-threaded agent can go quiet for a
    // while mid-enumerate.
    maxPayloadLength: 256 * 1024 * 1024,
    backpressureLimit: 256 * 1024 * 1024,
    idleTimeout: 300,

    open(ws) {
        // One of each. A new connection of the same role replaces the old one.
        if (ws.data.role === "ui") {
            ui?.close(1000, "replaced by newer ui");
            ui = ws;
        } else {
            agent?.close(1000, "replaced by newer agent");
            agent = ws;
        }
        console.log(`[+] ${ws.data.role} connected`);
    },

    message(ws, message) {
        if (ws.data.role === "agent") {
            // May be an RPC reply (resolve the caller) or a UI reply (forward on).
            routeAgentFrame(message);
        } else {
            // UI -> agent: forward verbatim, no parsing, no caching.
            peerOf(ws.data.role)?.send(message);
        }
    },

    close(ws, code, reason) {
        if (ws.data.role === "ui" && ui === ws) ui = null;
        if (ws.data.role === "agent" && agent === ws) {
            agent = null;
            // No agent means no reply will ever come - fail every in-flight RPC now
            // rather than letting each one wait out its timeout.
            rejectAllRpc(new Error("agent disconnected"));
        }
        console.log(`[-] ${ws.data.role} disconnected (code ${code}${reason ? `, ${reason}` : ""})`);
    },
};
