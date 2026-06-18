import { createSignal, type Accessor } from "solid-js";

// Raw WebSocket lifecycle: connect, auto-reconnect, status. Knows nothing about the
// protocol - it just moves text frames and exposes a reactive status signal.

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface ConnectionEvents {
    message: (data: string) => void;
    close: () => void;
}

const RECONNECT_DELAY_MS = 1000;

// The relay closes a socket with code 1000 when a newer client of the same role takes over
// ("replaced by newer ui"). That's deliberate - reconnecting would just steal the socket back
// and start an endless flap between the two clients - so a replaced client stays closed. A real
// drop or relay restart closes abnormally (1006/1001), which we do reconnect on.
const CLOSE_REPLACED = 1000;

export class Connection {
    readonly status: Accessor<ConnectionStatus>;
    private readonly setStatus: (s: ConnectionStatus) => void;

    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private closedByUser = false;
    private readonly url: string;
    private readonly events: ConnectionEvents;

    constructor(url: string, events: ConnectionEvents) {
        this.url = url;
        this.events = events;
        const [status, setStatus] = createSignal<ConnectionStatus>("closed");
        this.status = status;
        this.setStatus = setStatus;
    }

    connect(): void {
        this.closedByUser = false;
        this.open();
    }

    private open(): void {
        this.setStatus("connecting");
        const ws = new WebSocket(this.url);
        this.ws = ws;

        ws.onopen = () => this.setStatus("open");

        ws.onmessage = (e) => {
            if (typeof e.data === "string") this.events.message(e.data);
        };

        ws.onclose = (e) => {
            this.ws = null;
            this.setStatus("closed");
            this.events.close();
            if (!this.closedByUser) {
                console.warn(`[relay] socket closed: code ${e.code}${e.reason ? ` (${e.reason})` : ""}`);
                if (e.code !== CLOSE_REPLACED) this.scheduleReconnect();
            }
        };

        ws.onerror = () => ws.close();
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer !== null) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.open();
        }, RECONNECT_DELAY_MS);
    }

    send(data: string): boolean {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(data);
            return true;
        }
        return false;
    }

    close(): void {
        this.closedByUser = true;
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
    }
}
