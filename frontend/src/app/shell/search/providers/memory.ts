import { hasQueryText } from "../query";
import type { SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";
import { copyAction } from "./util";

// Memory Viewer classes and their fields. Cheap cached read. A class opens directly in the Memory
// Viewer; a field opens its owning class (the field offset is a computed layout value, not stored
// per node, so a precise jump-to-field is not attempted here). Fields are only contributed once the
// user has typed, to keep the empty-query view class-level.

interface Node {
    id: string;
    name?: string;
    typeId?: string;
}

export const memoryProvider: SearchProvider = {
    id: "memory",
    group: "Memory",
    prefix: "#",
    scopes: ["memory", "field"],
    emptyResults: true,
    maxResults: 40,
    search(query, ctx) {
        const s = paletteStores(ctx);
        const out: SearchResult[] = [];
        const typed = hasQueryText(query);

        for (const cls of s.memory.classes) {
            const name = cls.name || "(unnamed class)";
            const fieldCount = cls.nodes.length;
            out.push({
                id: `memclass:${cls.id}`,
                providerId: "memory",
                group: "Memory",
                title: name,
                subtitle: `Memory class · ${fieldCount} field${fieldCount === 1 ? "" : "s"}`,
                hint: cls.address || undefined,
                icon: "memory",
                keywords: `memory class ${name} ${cls.address}`,
                defaultAction: { id: "open", label: "Open in Memory Viewer", run: () => s.app.setActiveView("memory", cls.id) },
                altActions: cls.address
                    ? [
                          { id: "disasm", label: "Go to address in disassembler", icon: "static", run: (c) => c.goto("static", cls.address, name) },
                          copyAction("copy", "Copy address", cls.address),
                      ]
                    : undefined,
                preview: () => ({
                    title: name,
                    rows: [
                        { label: "Address", value: cls.address || "—" },
                        { label: "Fields", value: String(fieldCount) },
                    ],
                }),
            });

            if (!typed) continue;
            for (const node of cls.nodes as Node[]) {
                if (!node.name) continue;
                out.push({
                    id: `memfield:${cls.id}:${node.id}`,
                    providerId: "memory",
                    group: "Memory",
                    title: node.name,
                    subtitle: `${name}${node.typeId ? ` · ${node.typeId}` : ""}`,
                    icon: "memory",
                    keywords: `field ${node.name} ${node.typeId ?? ""} ${name}`,
                    defaultAction: { id: "open", label: "Open class in Memory Viewer", run: () => s.app.setActiveView("memory", cls.id) },
                });
            }
        }
        return out;
    },
};
