import { useApp } from "../AppContext";
import { useMemory } from "../../views/memory/state/MemoryContext";
import { exportSession, importSession } from "../../state/session";
import { downloadText, pickTextFile } from "../../state/fileio";

// Save / Load Session, factored out of the old TopBar so both the Session menu and the command
// palette invoke exactly the same logic. Unchanged behaviour: bundles cheat + bookmarks + memory
// classes into web-mv-session.json; load merges (append semantics), malformed files are ignored.

export function useSessionActions() {
    const app = useApp();
    const memory = useMemory();
    const stores = () => ({ cheat: app.cheat, bookmarks: app.bookmarks, memory });

    return {
        save() {
            downloadText("web-mv-session.json", exportSession(stores()));
        },
        async load() {
            const text = await pickTextFile();
            if (text === undefined) return;
            try {
                importSession(text, stores());
            } catch {
                /* malformed file - ignore, per-store imports are best-effort */
            }
        },
    };
}
