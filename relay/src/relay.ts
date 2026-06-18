import type { ServerWebSocket, WebSocketHandler } from "bun";

// The relay is intentionally dumb: it knows nothing about the protocol. It holds
// exactly one UI socket and one agent socket and forwards raw frames between them.

export type Role = "ui" | "agent";

export interface SocketData {
    role: Role;
}

let ui: ServerWebSocket<SocketData> | null = null;
let agent: ServerWebSocket<SocketData> | null = null;

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
        // Forward verbatim. No parsing, no caching.
        peerOf(ws.data.role)?.send(message);
    },

    close(ws, code, reason) {
        if (ws.data.role === "ui" && ui === ws) ui = null;
        if (ws.data.role === "agent" && agent === ws) agent = null;
        console.log(`[-] ${ws.data.role} disconnected (code ${code}${reason ? `, ${reason}` : ""})`);
    },
};
