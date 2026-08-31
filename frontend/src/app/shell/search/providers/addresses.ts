import { hasQueryText } from "../query";
import type { NavEntry } from "../../../../state/navStore";
import type { SearchAction, SearchContext, SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";
import { copyAction } from "./util";

// Centralized address actions that wire the Memory Watch (Phase 2) and Emulator (Phase 3) features
// into navigation: every resolved address in the palette can spawn a watch or an emulator session.
// Loosely typed against the app store bag (the palette's single seam to app state).
interface AddrActionApp {
    watches?: { add?: (i: { expression: string; valueType: string; name?: string }) => void };
    emulator?: { availability?: () => string; createSession?: (i: { entryAddress: string }) => unknown };
}
function addressActions(address: string, label: string): SearchAction[] {
    const acts: SearchAction[] = [
        {
            id: "watch",
            label: "Add Memory Watch",
            icon: "watch",
            run: (c: SearchContext) => {
                (c.stores as { app?: AddrActionApp }).app?.watches?.add?.({ expression: address, valueType: "int32", name: label });
                c.openView("watch");
            },
        },
    ];
    return acts;
}
function emulateAction(address: string): SearchAction {
    return {
        id: "emulate",
        label: "Emulate from here",
        icon: "emulator",
        run: (c: SearchContext) => {
            const app = (c.stores as { app?: AddrActionApp }).app;
            const avail = app?.emulator?.availability?.();
            // Prepare a session (no execution); only when the capability is live. Otherwise just open
            // the Emulator view so the user sees the honest unavailable state.
            if (avail === "available" || avail === "assumed") app?.emulator?.createSession?.({ entryAddress: address });
            c.openView("emulator");
        },
    };
}

// Address omnibox. When the query itself parses as an address expression (`0x1400+0x28`,
// `client.dll+0x1a3f`, a bare hex value), synthesise direct "go to" results. Also surfaces the
// recent navigation addresses from the jump history. Nothing here fetches.

export const addressesProvider: SearchProvider = {
    id: "addresses",
    group: "Addresses",
    prefix: "#",
    scopes: ["address"],
    emptyResults: true,
    maxResults: 12,
    search(query, ctx) {
        const s = paletteStores(ctx);
        const out: SearchResult[] = [];

        if (hasQueryText(query)) {
            const resolved = ctx.resolveAddress(query.text);
            if (resolved) {
                const { address, label } = resolved;
                // A high base score so a clean address expression leads the results.
                out.push({
                    id: `goto-static:${address}`,
                    providerId: "addresses",
                    group: "Addresses",
                    title: `Go to ${label} in disassembler`,
                    subtitle: address !== label ? address : undefined,
                    hint: address,
                    icon: "static",
                    keywords: `goto address ${address} ${label}`,
                    baseScore: 240,
                    defaultAction: { id: "go", label: "Go to in disassembler", run: (c) => c.goto("static", address, label) },
                    altActions: [
                        { id: "mem", label: "Open in Memory Viewer", icon: "memory", run: (c) => c.goto("memory", address, label) },
                        ...addressActions(address, label),
                        emulateAction(address),
                        copyAction("copy", "Copy address", address),
                    ],
                });
                out.push({
                    id: `goto-memory:${address}`,
                    providerId: "addresses",
                    group: "Addresses",
                    title: `Open ${label} in Memory Viewer`,
                    subtitle: address !== label ? address : undefined,
                    hint: address,
                    icon: "memory",
                    keywords: `open address memory ${address} ${label}`,
                    baseScore: 220,
                    defaultAction: { id: "mem", label: "Open in Memory Viewer", run: (c) => c.goto("memory", address, label) },
                    altActions: [copyAction("copy", "Copy address", address)],
                });
            }
        }

        // Recent navigation addresses (newest first, unique by address).
        const seen = new Set<string>();
        const entries = s.app.nav.entries as readonly NavEntry[];
        for (let i = entries.length - 1; i >= 0 && seen.size < 8; i--) {
            const e = entries[i];
            if (seen.has(e.address)) continue;
            seen.add(e.address);
            out.push({
                id: `recent-addr:${e.kind}:${e.address}`,
                providerId: "addresses",
                group: "Addresses",
                title: `Go to ${e.label ?? e.address}`,
                subtitle: "Recent",
                hint: e.address,
                icon: e.kind === "memory" ? "memory" : "static",
                keywords: `recent address ${e.address} ${e.label ?? ""}`,
                boost: 5,
                defaultAction: { id: "go", label: "Go to", run: (c) => c.goto(e.kind, e.address, e.label) },
                altActions: [copyAction("copy", "Copy address", e.address)],
            });
        }

        return out;
    },
};
