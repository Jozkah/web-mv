import { useApp } from "./AppContext";
import { useStatic } from "../views/static/state/StaticContext";
import { useMemory } from "../views/memory/state/MemoryContext";
import { parseAddressExpr, toHex } from "../state/address";
import { resolveLabel } from "../state/labels";
import type { NavEntry, NavKind } from "../state/navStore";
import type { ModuleEntry } from "../protocol/types";

// The navigation coordinator: the single funnel every code/data jump goes through. It performs
// the jump (switch view + point the target view at the address) AND records it on the nav stack.
// Kept as a hook rather than app state because performing a jump reaches into the per-view
// providers (openAddress / addClassAt) that sit *below* AppContext - only a component under those
// providers can call them. Back/forward move the cursor and re-jump WITHOUT recording, so the
// stack is stable while walking it. Must be called from within the provider tree (e.g. TopBar).

// Match a module by the name a user is likely to type: exact, or without the file extension, or a
// bare-name match against a stored "name.dll". Case-insensitive throughout.
function findModule(modules: readonly ModuleEntry[], name: string): ModuleEntry | undefined {
    const q = name.trim().toLowerCase();
    if (!q) return undefined;
    return (
        modules.find((m) => m.name.toLowerCase() === q) ??
        modules.find((m) => m.name.toLowerCase().replace(/\.[^.]+$/, "") === q) ??
        modules.find((m) => m.name.toLowerCase().replace(/\.[^.]+$/, "") === q.replace(/\.[^.]+$/, ""))
    );
}

export interface GotoResolution {
    address: string;
    label: string;
}

// Resolve free-form Goto input to an absolute address. Accepts a `module+offset` form
// ("game.dll+0x1a3f", "game + 40") or a plain address expression ("0x7ff6... + 0x28", "1400000").
// Returns undefined when nothing parses or the named module is unknown.
export function resolveGotoInput(text: string, modules: readonly ModuleEntry[]): GotoResolution | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;

    // module+offset: split on the first '+' where the left side is not itself numeric hex.
    const plus = trimmed.indexOf("+");
    if (plus > 0) {
        const left = trimmed.slice(0, plus).trim();
        const right = trimmed.slice(plus + 1).trim();
        const looksNumeric = /^(?:0x)?[0-9a-f]+$/i.test(left);
        if (!looksNumeric) {
            const mod = findModule(modules, left);
            if (!mod) return undefined;
            const off = parseAddressExpr(right || "0");
            if (off === undefined) return undefined;
            const address = toHex(BigInt(mod.base) + off);
            return { address, label: resolveLabel(address, modules) };
        }
    }

    const abs = parseAddressExpr(trimmed);
    if (abs === undefined) return undefined;
    const address = toHex(abs);
    return { address, label: resolveLabel(address, modules) };
}

export function useNavigation() {
    const app = useApp();
    const staticCtx = useStatic();
    const memory = useMemory();

    // The raw jump: switch to the target view and point it at the address. No recording.
    function jump(entry: NavEntry) {
        if (entry.kind === "static") {
            app.setActiveView("static");
            staticCtx.openAddress(entry.address);
        } else {
            // Focus an existing class already sitting at this address rather than spawning a
            // duplicate (this makes back/forward into memory stable and Goto idempotent); only
            // create a new class when none is there yet.
            const existing = memory.classes.find((c) => c.address === entry.address);
            if (existing) {
                memory.selectClass(existing.id);
                app.setActiveView("memory", existing.id);
            } else {
                const id = memory.addClassAt(entry.address, entry.label);
                app.setActiveView("memory", id);
            }
        }
    }

    return {
        canBack: () => app.nav.canBack(),
        canForward: () => app.nav.canForward(),

        // The public jump: record then navigate. Every user-initiated jump (Goto, xref click,
        // scan hit, bookmark, history, string, function-list click) should call this so the
        // back/forward stack captures it.
        goto(kind: NavKind, address: string, label?: string) {
            app.nav.push({ kind, address, label });
            jump({ kind, address, label });
        },

        back() {
            const entry = app.nav.back();
            if (entry) jump(entry);
        },
        forward() {
            const entry = app.nav.forward();
            if (entry) jump(entry);
        },
    };
}

export type Navigation = ReturnType<typeof useNavigation>;
