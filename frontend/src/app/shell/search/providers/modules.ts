import type { ModuleEntry } from "../../../../protocol/types";
import type { SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";
import { copyAction, humanSize, moduleEnd } from "./util";

// The upgraded module provider (spec §3). Modules carry a rich action set and display, and rank so
// that exact/extensionless/prefix name matches lead. The main module (its base equals the attached
// process base) gets a small context boost and a badge. Entries are deduped case-insensitively.

function extensionless(name: string): string {
    return name.replace(/\.[^.]+$/, "");
}

export const modulesProvider: SearchProvider = {
    id: "modules",
    group: "Modules",
    prefix: "@",
    scopes: ["module"],
    maxResults: 30,
    available(ctx) {
        const s = paletteStores(ctx);
        const st = s.app.modules.status();
        if (st === "loading") return { reason: "Module list loading…" };
        if (st === "error") return { reason: s.app.modules.error() ?? "Module list failed to load" };
        if (s.app.modules.list().length === 0) return { reason: "No modules — attach a target first" };
        return true;
    },
    search(_q, ctx) {
        const s = paletteStores(ctx);
        const mainBase = s.app.base();
        const seen = new Set<string>();
        const out: SearchResult[] = [];
        for (const m of s.app.modules.list() as ModuleEntry[]) {
            const key = m.name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            const isMain = !!mainBase && m.base === mainBase;
            const end = moduleEnd(m.base, m.size);
            const bare = extensionless(m.name);
            out.push({
                id: `module:${m.name}`,
                providerId: "modules",
                group: "Modules",
                title: m.name,
                subtitle: `${m.base} – ${end} · ${humanSize(m.size)}`,
                hint: m.base,
                icon: "static",
                keywords: `module ${bare} ${m.base}`,
                baseScore: isMain ? 40 : 0,
                badges: isMain ? [{ label: "main", kind: "main" }] : undefined,
                defaultAction: {
                    id: "disasm",
                    label: "Open base in disassembler",
                    icon: "static",
                    run: (c) => c.goto("static", m.base, m.name),
                },
                altActions: [
                    { id: "memory", label: "Open base in Memory Viewer", icon: "memory", run: (c) => c.goto("memory", m.base, m.name) },
                    { id: "pe", label: "Open PE / Symbols view", icon: "pe", run: () => s.ws.openOrFocusView("pe") },
                    {
                        id: "strings",
                        label: "Scan module strings",
                        icon: "strings",
                        run: () => {
                            s.ws.openOrFocusView("strings");
                            void s.strings.scan(m.name, m.base, m.size);
                        },
                    },
                    { id: "regions", label: "Open memory regions", icon: "regions", run: () => s.ws.openOrFocusView("regions") },
                    { id: "sigscan", label: "Signature scan window", icon: "sigscan", run: () => s.shell.setSigScanOpen(true) },
                    { id: "valuescan", label: "Value scan (Scanner)", icon: "scanner", run: () => s.ws.openOrFocusView("scanner") },
                    copyAction("copy-name", "Copy module name", m.name),
                    copyAction("copy-base", "Copy base address", m.base),
                    copyAction("copy-expr", "Copy module+0x0 expression", `${m.name}+0x0`),
                    { id: "side", label: "Open base in side split", icon: "split", kind: "split", run: (c) => c.openSideSplit("static") },
                ],
                preview: () => ({
                    title: m.name,
                    rows: [
                        { label: "Base", value: m.base },
                        { label: "End", value: end },
                        { label: "Size", value: `${humanSize(m.size)} (${m.size} bytes)` },
                        { label: "Main", value: isMain ? "yes" : "no" },
                    ],
                }),
            });
        }
        return out;
    },
};
