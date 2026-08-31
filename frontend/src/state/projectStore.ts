import type { Accessor } from "solid-js";
import type { WatchStore } from "./watchStore";
import type { PatchStore } from "./patchStore";
import type { CheatStore } from "./cheatStore";
import type { NetworkStore } from "./networkStore";
import { buildBundle, compareBundles, parseBundle, type ProjectBundle, type ProjectComparison, type TargetFingerprint } from "../project/projectBundle";

// Project database: gathers the per-target workspace (watches, patches, cheat) into one versioned,
// migratable bundle and scatters an imported bundle back to each store. Importing NEVER auto-applies
// writes/patches — the watch/patch stores load their sections disabled/pending and require explicit,
// identity-matched action. Also compares two bundles (target identity + patch/watch diffs).

export interface ProjectStoreDeps {
    watches: WatchStore;
    patches: PatchStore;
    cheat: CheatStore;
    network?: NetworkStore;
    fingerprint: Accessor<TargetFingerprint>;
    nowIso?: () => string;
}

function safeArray(json: string, key: string): Record<string, unknown>[] {
    try {
        const obj = JSON.parse(json) as Record<string, unknown>;
        const arr = obj[key];
        return Array.isArray(arr) ? (arr as Record<string, unknown>[]) : [];
    } catch {
        return [];
    }
}

export function createProjectStore(deps: ProjectStoreDeps) {
    const nowIso = deps.nowIso ?? (() => new Date().toISOString());

    function snapshot(): ProjectBundle {
        return buildBundle({
            createdAt: nowIso(),
            appVersion: "web-mv",
            target: deps.fingerprint(),
            watches: safeArray(deps.watches.exportDefinitions(), "watches"),
            patches: safeArray(deps.patches.exportJSON(), "patches"),
            cheat: (() => { try { return JSON.parse(deps.cheat.exportJson()) as Record<string, unknown>[]; } catch { return []; } })(),
            network: deps.network?.exportBundle() ?? [],
        });
    }

    function exportJSON(): string {
        return JSON.stringify(snapshot(), null, 2);
    }

    // Import a bundle: parse+validate, then hand each section to its store's importer. Returns per-
    // section counts. Nothing is applied to the live process — patches/watches load inert.
    function importJSON(text: string): { watches: number; patches: number; cheat: number; network: number } {
        const bundle = parseBundle(text);
        const watches = bundle.watches ? deps.watches.importDefinitions(JSON.stringify({ watches: bundle.watches }), "keepBoth") : 0;
        const patches = bundle.patches ? deps.patches.importJSON(JSON.stringify({ schemaVersion: 1, patches: bundle.patches })) : 0;
        let cheat = 0;
        if (bundle.cheat) { try { cheat = deps.cheat.importJson(JSON.stringify(bundle.cheat)); } catch { cheat = 0; } }
        // Network metadata loads INERT (no tshark, no file access, source marked unavailable).
        const network = deps.network ? deps.network.importBundle(bundle.network) : 0;
        return { watches, patches, cheat, network };
    }

    function compareWith(text: string): { comparison: ProjectComparison; other: ProjectBundle } {
        const other = parseBundle(text);
        return { comparison: compareBundles(snapshot(), other), other };
    }

    return { snapshot, exportJSON, importJSON, compareWith };
}

export type ProjectStore = ReturnType<typeof createProjectStore>;
