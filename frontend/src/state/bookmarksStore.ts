import { createStore } from "solid-js/store";
import { load, persist } from "./persist";
import { normalizeAddr, isValidAddr } from "./cheatStore";

// Shared Bookmarks state, lifted out of the view so any surface can pin an address via `add`.

export interface Bookmark {
    id: string;
    address: string;
    label: string;
    note: string;
}

const STORAGE_KEY = "ax.bookmarks";
const STORAGE_VERSION = 1;

export function createBookmarksStore() {
    const saved = load<{ items: Bookmark[] }>(STORAGE_KEY, STORAGE_VERSION);
    const [store, setStore] = createStore<{ items: Bookmark[] }>({ items: saved?.items ?? [] });

    persist(STORAGE_KEY, STORAGE_VERSION, () => ({ items: store.items.map((b) => ({ ...b })) }));

    let seq = 0;
    const nextId = (): string => {
        seq++;
        return `bm_${Date.now().toString(36)}_${seq}`;
    };

    /** Add a bookmark from a raw address. Returns the new id, or undefined if the address is invalid. */
    const add = (rawAddress: string, label = "", note = ""): string | undefined => {
        const address = normalizeAddr(rawAddress);
        if (!isValidAddr(address)) return undefined;
        const id = nextId();
        setStore("items", (list) => [...list, { id, address, label: label.trim(), note: note.trim() }]);
        return id;
    };

    const remove = (id: string) => setStore("items", (l) => l.filter((b) => b.id !== id));

    const exportJson = (): string =>
        JSON.stringify(store.items.map((b) => ({ address: b.address, label: b.label, note: b.note })), null, 2);

    /** Import bookmarks from exported JSON (appends). Returns how many valid rows were added. */
    const importJson = (text: string): number => {
        const data: unknown = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error("expected a JSON array");
        let added = 0;
        for (const raw of data) {
            if (!raw || typeof raw !== "object") continue;
            const r = raw as Record<string, unknown>;
            const id = add(
                String(r.address ?? ""),
                typeof r.label === "string" ? r.label : "",
                typeof r.note === "string" ? r.note : "",
            );
            if (id !== undefined) added++;
        }
        return added;
    };

    return {
        get items() {
            return store.items;
        },
        add,
        remove,
        exportJson,
        importJson,
    };
}

export type BookmarksStore = ReturnType<typeof createBookmarksStore>;
