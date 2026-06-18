import { createEffect, onCleanup } from "solid-js";

// localStorage persistence for the durable state the user builds (class definitions, function
// annotations). Live/transient state - byte snapshots, poll data, connection status - is never
// stored; only the definitions worth surviving a refresh.
//
// Payloads are version-tagged. load() returns undefined on a missing key, a parse failure, or a
// version mismatch, so a schema change is discarded cleanly and the caller starts fresh rather
// than hydrating a shape it can no longer read. Writes are best-effort - a full or unavailable
// store (private mode) is swallowed, never fatal.

interface Envelope {
    v: number;
    data: unknown;
}

export function load<T>(key: string, version: number): T | undefined {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return undefined;
        const env = JSON.parse(raw) as Envelope | null;
        if (!env || env.v !== version) return undefined;
        return env.data as T;
    } catch {
        return undefined;
    }
}

export function save(key: string, version: number, data: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify({ v: version, data } satisfies Envelope));
    } catch {
        // storage full or unavailable - persistence is best-effort.
    }
}

// Write snapshot() to localStorage whenever it changes, debounced so a burst of edits (typing a
// name, resizing a field) collapses to one write. snapshot() is tracked, so it must read every
// reactive leaf it wants persisted; call this under an owner (a provider/component body).
export function persist(key: string, version: number, snapshot: () => unknown, delayMs = 400): void {
    createEffect(() => {
        const data = snapshot();
        const handle = setTimeout(() => save(key, version, data), delayMs);
        onCleanup(() => clearTimeout(handle));
    });
}
