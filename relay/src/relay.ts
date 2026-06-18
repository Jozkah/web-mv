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
