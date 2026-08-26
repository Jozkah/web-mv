import { hasQueryText } from "../query";
import { addressOf, defaultName, rvaOf } from "../../../../state/address";
import type { FunctionEntry } from "../../../../protocol/types";
import type { SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";
import { copyAction } from "./util";

// Functions and pinned symbols. Pinned functions come from the (cheap, cached) annotations store and
// are always searchable. The full per-module function list is large and fetched on demand, so it is
// only searched when its cache is already ready — and even then filtered BEFORE building results, so
// a 100k-entry module never materialises 100k objects per keystroke. When the cache is not ready, an
// explicit "Load functions" action fetches it rather than the palette fetching on a keystroke.

const MODULE_MATCH_CAP = 50;

export const functionsProvider: SearchProvider = {
    id: "functions",
    group: "Functions",
    prefix: "#",
    scopes: ["function", "symbol"],
    emptyResults: false,
    maxResults: 70,
    search(query, ctx) {
        const s = paletteStores(ctx);
        const out: SearchResult[] = [];
        const anns = s.app.annotations;

        // Pinned functions (cheap, always available).
        for (const a of anns.pinned()) {
            const base = s.app.modules.baseOf(a.module);
            const address = base ? addressOf(base, a.rva) : undefined;
            const name = a.name || defaultName(a.rva);
            out.push({
                id: `pinfn:${a.module}:${a.rva}`,
                providerId: "functions",
                group: "Functions",
                title: name,
                subtitle: `${a.module} · +${a.rva}${address ? ` · ${address}` : ""}`,
                hint: address,
                icon: "static",
                badges: [{ label: "pinned", kind: "info" }],
                keywords: `function pinned ${name} ${a.module} ${a.rva} ${address ?? ""}`,
                baseScore: 20,
                disabled: address ? undefined : { reason: `${a.module} not loaded` },
                defaultAction: {
                    id: "open",
                    label: "Open in disassembler",
                    run: (c) => {
                        if (address) c.goto("static", address, name);
                    },
                },
                altActions: address
                    ? [
                          { id: "mem", label: "Open in Memory Viewer", icon: "memory", run: (c) => c.goto("memory", address, name) },
                          copyAction("copy", "Copy address", address),
                      ]
                    : undefined,
            });
        }

        if (!hasQueryText(query)) return out;

        const module = s.staticCtx.selection.selectedModule();
        if (!module) return out;
        const base = s.app.modules.baseOf(module);
        const entry = s.staticCtx.functions.get(module);
        const status = entry?.status;

        if (!entry || status !== "ready" || !base) {
            // Offer an explicit fetch under a function/symbol scope rather than fetching on keystroke.
            if (query.scope === "function" || query.scope === "symbol") {
                out.push({
                    id: `fnload:${module}`,
                    providerId: "functions",
                    group: "Functions",
                    title: `Load functions for ${module}`,
                    subtitle: status === "loading" ? "loading…" : "not indexed yet",
                    icon: "static",
                    keywords: `load functions ${module}`,
                    baseScore: 200,
                    disabled: status === "loading" ? { reason: "already loading" } : undefined,
                    defaultAction: { id: "load", label: `Load functions for ${module}`, run: () => void s.staticCtx.functions.ensure(module) },
                });
            }
            return out;
        }

        // Cache is ready: filter cheaply, then build results only for matches.
        const q = query.text.toLowerCase();
        const list = (entry as { data: FunctionEntry[] }).data;
        let matched = 0;
        for (let i = 0; i < list.length && matched < MODULE_MATCH_CAP; i++) {
            const fn = list[i];
            const rva = rvaOf(base, fn.address);
            const name = anns.nameOf(module, rva) || defaultName(rva);
            if (!name.toLowerCase().includes(q) && !fn.address.toLowerCase().includes(q) && !rva.toLowerCase().includes(q)) continue;
            matched++;
            out.push({
                id: `fn:${module}:${rva}`,
                providerId: "functions",
                group: "Functions",
                title: name,
                subtitle: `${module} · +${rva} · ${fn.address}`,
                hint: fn.address,
                icon: "static",
                keywords: `function ${name} ${module} ${rva} ${fn.address}`,
                defaultAction: { id: "open", label: "Open in disassembler", run: (c) => c.goto("static", fn.address, name) },
                altActions: [
                    { id: "mem", label: "Open in Memory Viewer", icon: "memory", run: (c) => c.goto("memory", fn.address, name) },
                    copyAction("copy", "Copy address", fn.address),
                ],
            });
        }
        return out;
    },
};
