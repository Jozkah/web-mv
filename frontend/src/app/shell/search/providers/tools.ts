import type { SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";

// Scanner / PE / Regions entry points. These views keep their data view-local (not shared through a
// context or cache), so their live rows cannot be searched from the palette. Instead this provider
// answers the `scan:` / `pe:` / `region:` scopes with contextual "open" results, and the views load
// their data on user intent. Grouped per view so the scope-exact ranking boost applies.

export const toolsProvider: SearchProvider = {
    id: "tools",
    group: "Scanner",
    scopes: ["scan", "pe", "region"],
    maxResults: 6,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        const out: SearchResult[] = [
            {
                id: "tool:scanner",
                providerId: "tools",
                group: "Scanner",
                title: "Open Value Scanner",
                subtitle: "scan process/module memory for values",
                icon: "scanner",
                keywords: "scan scanner value search memory",
                defaultAction: { id: "open", label: "Open Value Scanner", run: () => s.ws.openOrFocusView("scanner") },
                altActions: [{ id: "side", label: "Open in side split", icon: "split", kind: "split", run: (c) => c.openSideSplit("scanner") }],
            },
            {
                id: "tool:pe",
                providerId: "tools",
                group: "PE",
                title: "Open PE / Symbols",
                subtitle: "sections, imports, exports, directories",
                icon: "pe",
                keywords: "pe sections imports exports directories headers symbols",
                defaultAction: { id: "open", label: "Open PE / Symbols", run: () => s.ws.openOrFocusView("pe") },
                altActions: [{ id: "side", label: "Open in side split", icon: "split", kind: "split", run: (c) => c.openSideSplit("pe") }],
            },
            {
                id: "tool:regions",
                providerId: "tools",
                group: "Regions",
                title: "Open Memory Regions",
                subtitle: "committed regions and protections",
                icon: "regions",
                keywords: "regions memory map protection committed",
                defaultAction: { id: "open", label: "Open Memory Regions", run: () => s.ws.openOrFocusView("regions") },
                altActions: [{ id: "side", label: "Open in side split", icon: "split", kind: "split", run: (c) => c.openSideSplit("regions") }],
            },
        ];
        return out;
    },
};
