import { CATEGORIES } from "../../categories";
import { THEMES } from "../../ShellContext";
import { shortcutLabel } from "../../shortcuts";
import type { TabKind } from "../../../WorkspaceContext";
import type { SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";

// Static command surfaces: every view, the global actions, and the themes. These never fetch and
// are cheap to build, so they always contribute; ranking does the filtering. They also seed the
// empty-query suggestions (emptyResults) so an untouched palette still leads with useful entries.

export const viewsProvider: SearchProvider = {
    id: "views",
    group: "Views",
    prefix: ">",
    scopes: ["view", "command"],
    emptyResults: true,
    maxResults: 40,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        const out: SearchResult[] = [];
        for (const cat of CATEGORIES) {
            for (const v of cat.views) {
                const kind = v.kind as TabKind;
                out.push({
                    id: `view:${kind}`,
                    providerId: "views",
                    group: "Views",
                    title: `Open ${v.label}`,
                    hint: v.hint,
                    icon: kind === "sigscan" ? "sigscan" : (kind as string),
                    keywords: `${cat.label} ${v.label} ${v.hint}`,
                    defaultAction: {
                        id: "open",
                        label: `Open ${v.label}`,
                        run: () => {
                            if (kind === "sigscan") s.shell.setSigScanOpen(true);
                            else s.ws.openOrFocusView(kind);
                        },
                    },
                    altActions:
                        kind === "sigscan"
                            ? undefined
                            : [
                                  {
                                      id: "split",
                                      label: "Open in side split",
                                      icon: "split",
                                      kind: "split",
                                      run: () => ctx.openSideSplit(kind as string),
                                  },
                              ],
                });
            }
        }
        return out;
    },
};

export const themesProvider: SearchProvider = {
    id: "themes",
    group: "Themes",
    prefix: ">",
    scopes: ["theme", "command"],
    maxResults: 10,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        return THEMES.map((t) => ({
            id: `theme:${t.id}`,
            providerId: "themes",
            group: "Themes" as const,
            title: `Theme: ${t.label}`,
            hint: t.hint,
            icon: "theme",
            keywords: `theme appearance colour color light dark ${t.label}`,
            defaultAction: { id: "apply", label: `Apply ${t.label} theme`, run: () => s.shell.setTheme(t.id) },
        }));
    },
};

export const actionsProvider: SearchProvider = {
    id: "actions",
    group: "Actions",
    prefix: ">",
    scopes: ["action", "command"],
    emptyResults: true,
    maxResults: 40,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        const activeTabId = () => s.ws.activeTab()?.id;
        const out: SearchResult[] = [];
        const push = (
            id: string,
            title: string,
            keywords: string,
            run: () => void,
            opts: { icon?: string; kbd?: string; destructive?: boolean } = {},
        ) => {
            out.push({
                id: `action:${id}`,
                providerId: "actions",
                group: "Actions",
                title,
                icon: opts.icon,
                kbd: opts.kbd,
                keywords,
                defaultAction: {
                    id: "run",
                    label: title,
                    kind: opts.destructive ? "destructive" : "default",
                    run,
                },
            });
        };

        push("goto", "Go to address", "goto jump address navigate", () => s.shell.openGoto(), { icon: "target", kbd: shortcutLabel("Mod+G") });
        push("sigscan", "Signature Scan window", "pattern ida scan signature", () => s.shell.setSigScanOpen(true), { icon: "sigscan" });
        push("sigmaker", "SigMaker", "signature generate ida create", () => s.sigMaker.open({}), { icon: "static" });
        push("save", "Save Session", "download export json classes cheats bookmarks", () => s.session.save(), { icon: "export" });
        push("load", "Load Session", "import upload json merge", () => void s.session.load(), { icon: "session" });
        push("split", "Split active tab to side", "split group side", () => { const id = activeTabId(); if (id) s.ws.moveTabToSide(id); }, { icon: "split" });
        push("dup", "Duplicate active tab", "duplicate copy tab", () => { const id = activeTabId(); if (id) s.ws.duplicateTab(id); }, { icon: "plus" });
        push("sidebar", "Toggle sidebar", "sidebar panel collapse expand", () => s.shell.toggleSidebar(), { icon: "sidebar" });
        push("zen", "Toggle focus mode", "zen focus distraction chrome", () => s.shell.toggleZen(), { icon: "zen" });
        push("follow", "Attach — Follow Live target", "attach follow live process target", () => s.app.followLive(), { icon: "target" });
        // Closing a tab is destructive-ish: never fire from a bare Enter without the user meaning it.
        push("close", "Close active tab", "close tab", () => { const id = activeTabId(); if (id) s.ws.closeTab(id); }, { icon: "close", kbd: shortcutLabel("Mod+W"), destructive: true });
        if (s.ws.canReopen()) push("reopen", "Reopen closed tab", "reopen restore closed tab", () => s.ws.reopenClosedTab(), { icon: "plus" });

        return out;
    },
};
