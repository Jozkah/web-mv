import { load, save } from "./persist";

// The "workspace key" is the single namespace every per-target store (memory classes, function
// annotations, ...) prefixes its localStorage payload with. Switching the attached target flips
// this key, which re-keys those stores so each target loads its own classes/annotations rather
// than sharing one global blob.
//
// The agent's ping only tells us `attached`, `pid`, and `base`, so the key is built from the pid -
// stable for the life of a process - falling back to a fixed scratch key when nothing is attached.
// (The executable name, resolved separately from the module list, is display-only and not part of
// the key.) Kept as a pure function so it is trivial to reason about and test.

export const NO_TARGET_KEY = "none";

export interface TargetInfo {
    key: string;
    pid?: number;
    base?: string;
    /** Main-module (executable) file name, e.g. "game.exe". Resolved from the module list. */
    name?: string;
    lastSeen: number;
}

// Derive the namespace for the currently attached target. `none` is a shared scratch workspace
// used before any process is attached.
export function deriveWorkspaceKey(attached: boolean, pid?: number, base?: string): string {
    if (!attached) return NO_TARGET_KEY;
    if (pid !== undefined) return `pid:${pid}`;
    if (base) return `base:${base}`;
    return NO_TARGET_KEY;
}

// Human label for a target tab. Prefers the executable name when known, appending the pid so two
// instances of the same exe stay distinguishable ("game.exe · pid 13400").
export function targetLabel(t: TargetInfo): string {
    if (t.key === NO_TARGET_KEY) return "No target";
    if (t.name) return t.pid !== undefined ? `${t.name} · pid ${t.pid}` : t.name;
    if (t.pid !== undefined) return `pid ${t.pid}`;
    if (t.base) return `base ${t.base}`;
    return t.key;
}

// The known-targets registry is global (NOT itself namespaced) - it is the index of every target
// the user has attached to, so the target tab strip can offer them all.
const REGISTRY_KEY = "ax.targets";
const REGISTRY_VERSION = 1;

export function loadTargets(): TargetInfo[] {
    const saved = load<TargetInfo[]>(REGISTRY_KEY, REGISTRY_VERSION);
    if (!Array.isArray(saved)) return [];
    return saved.filter((t) => t && typeof t.key === "string" && typeof t.lastSeen === "number");
}

export function saveTargets(targets: TargetInfo[]): void {
    save(REGISTRY_KEY, REGISTRY_VERSION, targets);
}
