import type { z } from "zod";
import type { Accessor } from "solid-js";
import { Connection, type ConnectionStatus } from "./connection";
import { errorResult } from "../protocol/schemas";
import { ResponseType } from "../protocol/messages";
import { errorText } from "../state/errors";

// AxClient owns request/response correlation: it assigns incrementing ids, keeps a
// pending-request map keyed by id, and resolves/rejects on the matching response.
// All socket I/O is delegated to Connection.

/** Thrown when the agent returns an { type: "error", ... } frame. */
export class AxError extends Error {
    readonly code: number;
    readonly detail?: string;

    constructor(code: number, message: string, detail?: string) {
        super(message);
        this.name = "AxError";
        this.code = code;
        this.detail = detail;
    }
}

/**
 * Turn a caught request error into a display string. A specific AxError code maps to a
 * calm, caller-supplied message; everything else falls back to the raw error text. Caches
 * use this to translate an expected protocol error (e.g. an empty module) into UI copy.
 */
export function axErrorMessage(e: unknown, code: number, friendly: string): string {
    if (e instanceof AxError && e.code === code) return friendly;
    return errorText(e);
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    schema: z.ZodTypeAny;
    timer: ReturnType<typeof setTimeout>;
}

// Default ceiling for a request whose reply never arrives (agent detached mid-call but the
// socket stays up). Without this a pending promise hangs forever and wedges its caller's
// in-flight guard. Long, whole-module operations (enumerate, scans) override this per call.
export const REQUEST_TIMEOUT_MS = 8000;

export class AxClient {
    private readonly conn: Connection;
    private readonly pending = new Map<number, Pending>();
    private readonly instanceId = Math.floor(Math.random() * 10000) + 1;
    private seq = 1;

    private generateId(): number {
        const id = this.instanceId * 100000 + (this.seq++);
        if (this.seq >= 100000) this.seq = 1;
        return id;
    }

    constructor(url: string) {
        this.conn = new Connection(url, {
            message: (data) => this.onMessage(data),
            close: () => this.rejectAll(new Error("connection closed")),
        });
    }

    get status(): Accessor<ConnectionStatus> {
        return this.conn.status;
    }

    connect(): void {
        this.conn.connect();
    }

    disconnect(): void {
        this.conn.close();
    }

    /**
     * Send a request and resolve with the validated response. The caller passes the
     * Zod schema for the expected reply, giving end-to-end typing and validation.
     * Rejects with AxError on an error frame, or Error on send failure / close.
     */
    request<S extends z.ZodTypeAny>(
        type: string,
        payload: Record<string, unknown>,
        schema: S,
        timeoutMs: number = REQUEST_TIMEOUT_MS,
    ): Promise<z.infer<S>> {
        const id = this.generateId();
        return new Promise<z.infer<S>>((resolve, reject) => {
            const frame = JSON.stringify({ type, id, ...payload });
            if (!this.conn.send(frame)) {
                reject(new Error("not connected"));
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error("request timed out"));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                schema,
                timer,
            });
        });
    }

    private settle(pending: Pending): void {
        clearTimeout(pending.timer);
    }

    private onMessage(data: string): void {
        let frame: unknown;
        try {
            frame = JSON.parse(data);
        } catch {
            return;
        }
        if (typeof frame !== "object" || frame === null) return;

        const id = (frame as { id?: unknown }).id;
        if (typeof id !== "number") return;

        const pending = this.pending.get(id);
        if (!pending) return; // unknown/stale/timed-out id - drop it
        this.pending.delete(id);
        this.settle(pending);

        if ((frame as { type?: unknown }).type === ResponseType.Error) {
            const parsed = errorResult.safeParse(frame);
            if (parsed.success) {
                pending.reject(new AxError(parsed.data.code, parsed.data.message, parsed.data.detail));
            } else {
                pending.reject(new Error("malformed error frame"));
            }
            return;
        }

        const parsed = pending.schema.safeParse(frame);
        if (parsed.success) {
            pending.resolve(parsed.data);
        } else {
            pending.reject(new Error(`response failed validation: ${parsed.error.message}`));
        }
    }

    private rejectAll(err: Error): void {
        for (const pending of this.pending.values()) {
            this.settle(pending);
            pending.reject(err);
        }
        this.pending.clear();
    }
}
