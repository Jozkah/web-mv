import { createStore, reconcile } from "solid-js/store";
import { errorText } from "./errors";

// A keyed, fetch-once async cache backed by a Solid store, so reading one key's entry
// is fine-grained reactive. Used for things that are static for the lifetime of an
// attach (a module's function list, a function's disassembly): fetch on first request,
// serve from cache thereafter, refresh on demand, clear wholesale on re-attach.

export type CacheEntry<T> =
    | { status: "loading" }
    | { status: "ready"; data: T }
    | { status: "error"; error: string };

export function createAsyncCache<T, A extends unknown[] = []>(
    loader: (key: string, ...args: A) => Promise<T>,
    friendlyError: (e: unknown) => string = errorText,
) {
    const [store, setStore] = createStore<Record<string, CacheEntry<T>>>({});

    const load = async (key: string, ...args: A) => {
        setStore(key, { status: "loading" });
        try {
            setStore(key, { status: "ready", data: await loader(key, ...args) });
        } catch (e) {
            setStore(key, { status: "error", error: friendlyError(e) });
        }
    };

    return {
        get: (key: string): CacheEntry<T> | undefined => store[key],
        /** Fetch if not already cached (or if the last attempt errored). Idempotent. */
        ensure: (key: string, ...args: A) => {
            const entry = store[key];
            if (!entry || entry.status === "error") void load(key, ...args);
        },
        /** Force a re-fetch regardless of cache state. */
        refresh: (key: string, ...args: A) => void load(key, ...args),
        /** Drop everything - used when the process re-attaches and addresses move. */
        clear: () => setStore(reconcile({})),
    };
}

export type AsyncCache<T, A extends unknown[] = []> = ReturnType<typeof createAsyncCache<T, A>>;
