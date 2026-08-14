import { createStore, produce } from "solid-js/store";

// Back/forward navigation history for code/data jumps - the disassembler-style nav stack that
// Goto, xref clicks, scan hits, bookmarks and history all feed. Deliberately NOT persisted: every
// entry is an absolute address that moves when the process re-attaches (ASLR), so a stack restored
// from a previous session would point at stale memory. In-memory only, reset on reload.
//
// The store holds pure state (the entry list + a cursor). Performing a jump (switching view,
// calling openAddress / addClassAt) is the coordinator's job - see app/useNavigation.ts - because
// those actions live in the per-view providers this store sits above.

export type NavKind = "static" | "memory";

export interface NavEntry {
    kind: NavKind;
    /** Absolute, canonical hex address (0x...). */
    address: string;
    /** Optional human label shown in tooltips (function name, symbol, "game.dll+0x1234"). */
    label?: string;
}

const MAX_NAV_ENTRIES = 200;

interface NavState {
    entries: NavEntry[];
    /** Cursor into `entries`; -1 when empty. `entries[index]` is the current location. */
    index: number;
}

function sameEntry(a: NavEntry, b: NavEntry): boolean {
    return a.kind === b.kind && a.address === b.address;
}

export function createNavStore() {
    const [store, setStore] = createStore<NavState>({ entries: [], index: -1 });

    return {
        get entries() {
            return store.entries;
        },
        get index() {
            return store.index;
        },
        current(): NavEntry | undefined {
            return store.index >= 0 ? store.entries[store.index] : undefined;
        },
        canBack(): boolean {
            return store.index > 0;
        },
        canForward(): boolean {
            return store.index >= 0 && store.index < store.entries.length - 1;
        },

        // Record a new location. Truncates any forward history (standard browser semantics: a new
        // jump abandons the "forward" branch), de-dupes a jump to where we already are, and caps
        // the total so a long session cannot grow the stack without bound.
        push(entry: NavEntry) {
            setStore(
                produce((s) => {
                    const cur = s.index >= 0 ? s.entries[s.index] : undefined;
                    if (cur && sameEntry(cur, entry)) return;
                    if (s.index < s.entries.length - 1) {
                        s.entries.splice(s.index + 1);
                    }
                    s.entries.push(entry);
                    if (s.entries.length > MAX_NAV_ENTRIES) {
                        s.entries.splice(0, s.entries.length - MAX_NAV_ENTRIES);
                    }
                    s.index = s.entries.length - 1;
                }),
            );
        },

        // Move the cursor back/forward and return the entry to jump to (undefined at either end).
        // These never mutate the entry list - only the cursor - so the branch is preserved.
        back(): NavEntry | undefined {
            if (store.index <= 0) return undefined;
            setStore("index", store.index - 1);
            return store.entries[store.index];
        },
        forward(): NavEntry | undefined {
            if (store.index < 0 || store.index >= store.entries.length - 1) return undefined;
            setStore("index", store.index + 1);
            return store.entries[store.index];
        },

        clear() {
            setStore({ entries: [], index: -1 });
        },
    };
}

export type NavStore = ReturnType<typeof createNavStore>;
