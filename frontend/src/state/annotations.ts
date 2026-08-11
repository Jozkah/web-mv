import { createStore, produce } from "solid-js/store";
import { createMemo } from "solid-js";
import { defaultName } from "./address";
import { load, persist } from "./persist";

// Client-side function annotations: rename + pin. The agent is read-only and has no
// concept of names, so these live entirely here. Keyed by (module, RVA) so they
// survive module switches AND process re-attach within the session (the absolute VA
// would not). Persisted to localStorage by RVA, so they also survive a refresh.

export interface Annotation {
    module: string;
    rva: string;
    name?: string;
    pinned: boolean;
}

const compositeKey = (module: string, rva: string) => `${module}@${rva}`;

// Persistence. The record is stored as a flat list (the key is derivable from module+rva), and
// the keyed store is rebuilt from it on load. Entries are validated one by one so a single bad
// row is dropped rather than discarding every annotation; a version bump discards the lot.
const STORAGE_KEY = "ax.annotations";
const STORAGE_VERSION = 1;

function hydrate(): Record<string, Annotation> {
    const saved = load<Annotation[]>(STORAGE_KEY, STORAGE_VERSION);
    if (!Array.isArray(saved)) return {};

    const out: Record<string, Annotation> = {};
    for (const a of saved) {
        if (!a || typeof a.module !== "string" || typeof a.rva !== "string" || typeof a.pinned !== "boolean") continue;
        if (a.name !== undefined && typeof a.name !== "string") continue;
        if (!a.name && !a.pinned) continue; // an entry carrying nothing is junk - the same rule mutate() enforces
        out[compositeKey(a.module, a.rva)] = a.name === undefined
            ? { module: a.module, rva: a.rva, pinned: a.pinned }
            : { module: a.module, rva: a.rva, pinned: a.pinned, name: a.name };
    }
    return out;
}

export function createAnnotations() {
    const [store, setStore] = createStore<Record<string, Annotation>>(hydrate());

    persist(STORAGE_KEY, STORAGE_VERSION, () => Object.values(store).map((a) => ({ ...a })));

    const get = (module: string, rva: string): Annotation | undefined => store[compositeKey(module, rva)];

    // Mutate an entry, creating it if absent; drop it again if it carries nothing
    // worth keeping (no custom name and unpinned) so the store doesn't accumulate junk.
    const mutate = (module: string, rva: string, fn: (a: Annotation) => void) => {
        const key = compositeKey(module, rva);
        setStore(
            produce((s) => {
                const entry = s[key] ?? { module, rva, pinned: false };
                fn(entry);
                if (!entry.name && !entry.pinned) {
                    delete s[key];
                } else {
                    s[key] = entry;
                }
            }),
        );
    };

    return {
        /** Display name: the custom name if set, else the IDA-style sub_<rva> default. */
        nameOf(module: string, rva?: string): string {
            if (!module || !rva) return defaultName(rva);
            return get(module, rva)?.name ?? defaultName(rva);
        },
        /** True only when the user has assigned a custom name. */
        hasCustomName(module: string, rva?: string): boolean {
            if (!module || !rva) return false;
            return get(module, rva)?.name !== undefined;
        },
        isPinned(module: string, rva?: string): boolean {
            if (!module || !rva) return false;
            return get(module, rva)?.pinned ?? false;
        },
        rename(module: string, rva: string, name: string) {
            if (!module || !rva) return;
            const trimmed = name.trim();
            mutate(module, rva, (a) => {
                a.name = trimmed === "" || trimmed === defaultName(rva) ? undefined : trimmed;
            });
        },
        togglePin(module: string, rva: string) {
            if (!module || !rva) return;
            mutate(module, rva, (a) => {
                a.pinned = !a.pinned;
            });
        },
        /** All pinned functions, across every module - the global favorites list. */
        pinned: createMemo(() => Object.values(store).filter((a) => a.pinned)),
    };
}

export type Annotations = ReturnType<typeof createAnnotations>;
