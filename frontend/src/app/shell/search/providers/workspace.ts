import { targetLabel } from "../../../../state/workspaceKey";
import { defaultTabTitle } from "../../../WorkspaceContext";
import type { SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";

// Saved targets (workspaces) and currently open tabs. Both read cheap cached state.

export const targetsProvider: SearchProvider = {
    id: "targets",
    group: "Targets",
    prefix: "@",
    scopes: ["target"],
    emptyResults: true,
    maxResults: 20,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        return s.app.targets().map((t) => ({
            id: `target:${t.key}`,
            providerId: "targets",
            group: "Targets" as const,
            title: `Switch to ${targetLabel(t)}`,
            icon: "target",
            hint: t.base ?? undefined,
            keywords: `target workspace ${t.pid ?? ""} ${t.base ?? ""}`,
            defaultAction: { id: "switch", label: `Switch to ${targetLabel(t)}`, run: () => s.app.selectTarget(t.key) },
        }));
    },
};

export const tabsProvider: SearchProvider = {
    id: "tabs",
    group: "Tabs",
    scopes: ["tab"],
    emptyResults: true,
    maxResults: 30,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        const out: SearchResult[] = [];
        for (const g of s.ws.groups) {
            for (const tab of g.tabs) {
                const title = tab.title ?? defaultTabTitle(tab.kind);
                out.push({
                    id: `tab:${tab.id}`,
                    providerId: "tabs",
                    group: "Tabs",
                    title,
                    subtitle: "Open tab",
                    icon: tab.kind as string,
                    keywords: `tab ${title} ${tab.kind}`,
                    defaultAction: {
                        id: "focus",
                        label: `Focus ${title}`,
                        run: () => {
                            s.ws.focusGroup(g.id);
                            s.ws.selectTab(tab.id);
                        },
                    },
                    altActions: [
                        { id: "side", label: "Move to side split", icon: "split", kind: "split", run: () => s.ws.moveTabToSide(tab.id) },
                        { id: "close", label: "Close tab", icon: "close", kind: "destructive", run: () => s.ws.closeTab(tab.id) },
                    ],
                });
            }
        }
        if (s.ws.canReopen()) {
            out.push({
                id: "tab:reopen",
                providerId: "tabs",
                group: "Tabs",
                title: "Reopen closed tab",
                icon: "plus",
                keywords: "reopen restore closed tab",
                defaultAction: { id: "reopen", label: "Reopen closed tab", run: () => s.ws.reopenClosedTab() },
            });
        }
        return out;
    },
};
