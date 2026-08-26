import { toHex, parseHex } from "../../../../state/address";
import type { SearchAction, SearchContext, SearchResult } from "../types";

// Shared helpers for building results and their actions. Keeps the individual providers short and
// their result shapes consistent (icons, copy actions, human-readable sizes).

export function humanSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u++;
    }
    const s = v >= 100 || u === 0 ? v.toFixed(0) : v.toFixed(1);
    return `${s} ${units[u]}`;
}

// Absolute end address of a module given its base and size.
export function moduleEnd(base: string, size: number): string {
    try {
        return toHex(parseHex(base) + BigInt(size));
    } catch {
        return base;
    }
}

// A clipboard action that reports failure through the shared, resilient copy helper.
export function copyAction(id: string, label: string, text: string): SearchAction {
    return {
        id,
        label,
        icon: "export",
        run: async (ctx: SearchContext) => {
            await ctx.copy(text);
        },
    };
}

export function gotoAction(
    id: string,
    label: string,
    kind: "static" | "memory",
    address: string,
    resultLabel?: string,
    icon = kind === "memory" ? "memory" : "static",
): SearchAction {
    return {
        id,
        label,
        icon,
        run: (ctx: SearchContext) => ctx.goto(kind, address, resultLabel),
    };
}

// Attach a default id/provider/group scaffold, letting a provider spell out only the distinctive
// fields. Purely a convenience; the result object is otherwise plain data.
export function result(r: SearchResult): SearchResult {
    return r;
}
