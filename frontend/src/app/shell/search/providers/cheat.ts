import { resolveLabel } from "../../../../state/labels";
import type { ModuleEntry } from "../../../../protocol/types";
import type { SearchProvider } from "../types";
import { paletteStores } from "../stores";
import { copyAction } from "./util";

// Cheat-table entries. Cheap cached list. Opens in the Memory Viewer; the freeze toggle is offered
// as an alternate action (never fired by a bare Enter).

export const cheatProvider: SearchProvider = {
    id: "cheat",
    group: "Cheats",
    scopes: ["cheat"],
    emptyResults: true,
    maxResults: 30,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        const modules = s.app.modules.list() as ModuleEntry[];
        return s.app.cheat.entries.map((e) => {
            const modLabel = resolveLabel(e.address, modules);
            const title = e.desc || modLabel;
            return {
                id: `cheat:${e.id}`,
                providerId: "cheat",
                group: "Cheats" as const,
                title,
                subtitle: `${e.type}${e.frozen ? " · frozen" : ""} · ${e.address}`,
                hint: e.address,
                icon: "cheat",
                badges: e.frozen ? [{ label: "frozen", kind: "info" as const }] : undefined,
                keywords: `cheat ${e.desc} ${e.type} ${e.address} ${modLabel}`,
                defaultAction: { id: "mem", label: "Open in Memory Viewer", icon: "memory", run: (c) => c.goto("memory", e.address, title) },
                altActions: [
                    { id: "disasm", label: "Open in disassembler", icon: "static", run: (c) => c.goto("static", e.address, title) },
                    { id: "freeze", label: e.frozen ? "Unfreeze value" : "Freeze value", icon: "modify", run: () => s.app.cheat.toggleFreeze(e.id, e.frozenHex) },
                    copyAction("copy", "Copy address", e.address),
                ],
            };
        });
    },
};
