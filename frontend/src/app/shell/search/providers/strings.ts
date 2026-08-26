import { hasQueryText } from "../query";
import type { ModuleEntry } from "../../../../protocol/types";
import type { SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";
import { copyAction } from "./util";

// Extracted strings. Searches ONLY the already-cached extraction (allStrings, populated by a prior
// scan) — never scans a module because the user typed. When nothing is cached, offers an explicit
// "Scan module strings" action instead. Matches are filtered before results are built, capped, so a
// large extraction stays responsive.

const STRING_MATCH_CAP = 50;

interface StringEntry {
    address: string;
    value: string;
    type: "ascii" | "utf16";
    category: string;
}

export const stringsProvider: SearchProvider = {
    id: "strings",
    group: "Strings",
    scopes: ["string"],
    emptyResults: false,
    maxResults: 55,
    search(query, ctx) {
        const s = paletteStores(ctx);
        const out: SearchResult[] = [];
        const cached = s.strings.allStrings() as StringEntry[];

        if (cached.length === 0) {
            // Nothing cached — surface an explicit scan action (never scan implicitly).
            const modules = s.app.modules.list() as ModuleEntry[];
            const selName = s.strings.selectedModule();
            const mod = (selName && modules.find((m) => m.name === selName)) || modules.find((m) => m.base === s.app.base());
            if (mod && (query.scope === "string" || hasQueryText(query))) {
                out.push({
                    id: `strscan:${mod.name}`,
                    providerId: "strings",
                    group: "Strings",
                    title: `Scan strings in ${mod.name}`,
                    subtitle: "no cached strings yet",
                    icon: "strings",
                    keywords: `scan strings ${mod.name}`,
                    baseScore: 120,
                    defaultAction: {
                        id: "scan",
                        label: `Scan strings in ${mod.name}`,
                        run: () => {
                            s.ws.openOrFocusView("strings");
                            void s.strings.scan(mod.name, mod.base, mod.size);
                        },
                    },
                });
            }
            return out;
        }

        if (!hasQueryText(query)) return out;
        const q = query.text.toLowerCase();
        let matched = 0;
        for (let i = 0; i < cached.length && matched < STRING_MATCH_CAP; i++) {
            const str = cached[i];
            if (!str.value.toLowerCase().includes(q) && !str.address.toLowerCase().includes(q)) continue;
            matched++;
            out.push({
                id: `str:${str.address}`,
                providerId: "strings",
                group: "Strings",
                title: str.value,
                subtitle: `${str.type} · ${str.category} · ${str.address}`,
                hint: str.address,
                icon: "strings",
                keywords: `string ${str.address}`,
                defaultAction: { id: "mem", label: "Open in Memory Viewer", icon: "memory", run: (c) => c.goto("memory", str.address, str.value.slice(0, 24)) },
                altActions: [
                    { id: "disasm", label: "Open in disassembler", icon: "static", run: (c) => c.goto("static", str.address) },
                    copyAction("copy-addr", "Copy address", str.address),
                    copyAction("copy-val", "Copy string", str.value),
                ],
            });
        }
        return out;
    },
};
