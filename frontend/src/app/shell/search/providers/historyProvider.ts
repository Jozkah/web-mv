import { defaultName } from "../../../../state/address";
import type { SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";
import { copyAction } from "./util";

// Navigation history: functions visited, memory classes opened, signature scans and string scans.
// Cheap cached list (MRU). Each item re-invokes the thing it recorded.

function relativeAge(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    const m = Math.floor(diff / 60_000);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

export const historyProvider: SearchProvider = {
    id: "history",
    group: "History",
    scopes: ["history"],
    emptyResults: true,
    maxResults: 40,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        const out: SearchResult[] = [];
        for (const it of s.app.history.items) {
            const age = relativeAge(it.timestamp);
            if (it.type === "function") {
                const name = it.name || defaultName(it.rva);
                out.push({
                    id: `hist:${it.id}`,
                    providerId: "history",
                    group: "History",
                    title: name,
                    subtitle: `Function · ${it.module} · ${age}`,
                    hint: it.address,
                    icon: "history",
                    keywords: `history function ${name} ${it.module} ${it.rva} ${it.address}`,
                    defaultAction: { id: "open", label: "Open in disassembler", run: (c) => c.goto("static", it.address, name) },
                    altActions: [copyAction("copy", "Copy address", it.address)],
                });
            } else if (it.type === "memory") {
                out.push({
                    id: `hist:${it.id}`,
                    providerId: "history",
                    group: "History",
                    title: it.className,
                    subtitle: `Memory · ${age}`,
                    hint: it.address,
                    icon: "memory",
                    keywords: `history memory ${it.className} ${it.address}`,
                    defaultAction: { id: "open", label: "Open in Memory Viewer", run: () => s.app.setActiveView("memory", it.classId) },
                    altActions: [copyAction("copy", "Copy address", it.address)],
                });
            } else if (it.type === "scan") {
                out.push({
                    id: `hist:${it.id}`,
                    providerId: "history",
                    group: "History",
                    title: it.pattern,
                    subtitle: `Signature scan · ${it.hitCount} hit${it.hitCount === 1 ? "" : "s"} · ${age}`,
                    icon: "sigscan",
                    keywords: `history scan signature ${it.pattern} ${it.scope}`,
                    defaultAction: { id: "open", label: "Open signature scan window", run: () => s.shell.setSigScanOpen(true) },
                    altActions: [copyAction("copy", "Copy pattern", it.pattern)],
                });
            } else if (it.type === "string_scan") {
                out.push({
                    id: `hist:${it.id}`,
                    providerId: "history",
                    group: "History",
                    title: `Strings — ${it.module}`,
                    subtitle: `${it.stringCount} strings · ${age}`,
                    icon: "strings",
                    keywords: `history strings ${it.module}`,
                    defaultAction: { id: "open", label: "Open Strings view", run: () => s.ws.openOrFocusView("strings") },
                });
            }
        }
        return out;
    },
};
