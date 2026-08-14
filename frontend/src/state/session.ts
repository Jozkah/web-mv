// Full-session save / load: bundle the cheat table, bookmarks and memory class definitions into
// one JSON file so a whole reversing session round-trips through a single download / upload. Each
// store already owns a JSON round-trip; this just composes them under one envelope. Workspace tabs
// are intentionally excluded - they persist on their own and are layout, not reversing data.

interface JsonStore {
    exportJson: () => string;
    importJson: (text: string) => number;
}

export interface SessionStores {
    cheat: JsonStore;
    bookmarks: JsonStore;
    memory: JsonStore;
}

const SESSION_VERSION = 1;

export function exportSession(stores: SessionStores): string {
    return JSON.stringify(
        {
            v: SESSION_VERSION,
            cheat: JSON.parse(stores.cheat.exportJson()),
            bookmarks: JSON.parse(stores.bookmarks.exportJson()),
            memory: JSON.parse(stores.memory.exportJson()),
        },
        null,
        2,
    );
}

export interface ImportSummary {
    cheat: number;
    bookmarks: number;
    memory: number;
}

// Merge a saved session into the current one (append semantics, matching each store's importJson).
// Missing sections are skipped so a partial/older file still loads what it can.
export function importSession(text: string, stores: SessionStores): ImportSummary {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("not a session file");
    const d = data as Record<string, unknown>;
    const summary: ImportSummary = { cheat: 0, bookmarks: 0, memory: 0 };
    if (d.cheat !== undefined) summary.cheat = stores.cheat.importJson(JSON.stringify(d.cheat));
    if (d.bookmarks !== undefined) summary.bookmarks = stores.bookmarks.importJson(JSON.stringify(d.bookmarks));
    if (d.memory !== undefined) summary.memory = stores.memory.importJson(JSON.stringify(d.memory));
    return summary;
}
