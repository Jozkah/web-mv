import { resolveLabel } from "../../../../state/labels";
import type { ModuleEntry } from "../../../../protocol/types";
import type { SearchProvider } from "../types";
import { paletteStores } from "../stores";
import { copyAction } from "./util";

// Bookmarks. Cheap cached list. Searchable by label, note, address and resolved module label; opens
// in the Memory Viewer by default, with disassembler and copy alternates.

export const bookmarksProvider: SearchProvider = {
    id: "bookmarks",
    group: "Bookmarks",
    prefix: "#",
    scopes: ["bookmark"],
    emptyResults: true,
    maxResults: 30,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        const modules = s.app.modules.list() as ModuleEntry[];
        return s.app.bookmarks.items.map((b) => {
            const modLabel = resolveLabel(b.address, modules);
            const title = b.label || modLabel;
            return {
                id: `bookmark:${b.id}`,
                providerId: "bookmarks",
                group: "Bookmarks" as const,
                title,
                subtitle: b.note || modLabel,
                hint: b.address,
                icon: "bookmarks",
                keywords: `bookmark ${b.label} ${b.note} ${b.address} ${modLabel}`,
                defaultAction: { id: "mem", label: "Open in Memory Viewer", icon: "memory", run: (c) => c.goto("memory", b.address, title) },
                altActions: [
                    { id: "disasm", label: "Open in disassembler", icon: "static", run: (c) => c.goto("static", b.address, title) },
                    copyAction("copy", "Copy address", b.address),
                ],
                preview: () => ({
                    title,
                    rows: [
                        { label: "Address", value: b.address },
                        { label: "Module", value: modLabel },
                    ],
                    body: b.note || undefined,
                }),
            };
        });
    },
};
