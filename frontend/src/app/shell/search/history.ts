import { load, loadRaw, save } from "../../../state/persist";
import type { RankSignals } from "./ranking";

// Search personalization, persisted to localStorage. Tracks which results the user runs (usage
// counts + MRU order), pinned favourites, and recent query strings. Feeds ranking boosts and the
// empty-query recents/favorites view. Versioned; migrates the old `ax.palette.recent` list so a
// user's existing recent commands survive the upgrade (spec §8).

const KEY = "ax.search.history";
const VERSION = 2;
const OLD_RECENT_KEY = "ax.palette.recent";

const RECENT_MAX = 30;
const QUERY_MAX = 20;
const USAGE_MAX = 200;

export interface SearchHistoryData {
    usage: Record<string, number>;
    recent: string[];
    queries: string[];
    pinned: string[];
    enabled: boolean; // query-history persistence toggle (spec §8: users may disable it)
}

function empty(): SearchHistoryData {
    return { usage: {}, recent: [], queries: [], pinned: [], enabled: true };
}

function sanitize(raw: unknown): SearchHistoryData {
    const d = empty();
    if (!raw || typeof raw !== "object") return d;
    const r = raw as Partial<SearchHistoryData>;
    if (r.usage && typeof r.usage === "object") {
        for (const [k, v] of Object.entries(r.usage)) if (typeof v === "number" && v > 0) d.usage[k] = v;
    }
    if (Array.isArray(r.recent)) d.recent = r.recent.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX);
    if (Array.isArray(r.queries)) d.queries = r.queries.filter((x): x is string => typeof x === "string").slice(0, QUERY_MAX);
    if (Array.isArray(r.pinned)) d.pinned = r.pinned.filter((x): x is string => typeof x === "string");
    if (typeof r.enabled === "boolean") d.enabled = r.enabled;
    return d;
}

// In-memory mirror, loaded once. Keeps keystroke-time reads off localStorage.
let state: SearchHistoryData | null = null;

function read(): SearchHistoryData {
    if (state) return state;
    const stored = load<SearchHistoryData>(KEY, VERSION);
    if (stored) {
        state = sanitize(stored);
        return state;
    }
    // Migration: seed recents from the legacy palette recent-command list, if present.
    const legacy = loadRaw(OLD_RECENT_KEY);
    const seed = empty();
    if (legacy && Array.isArray(legacy.data)) {
        seed.recent = (legacy.data as unknown[]).filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX);
    }
    state = seed;
    persist();
    return state;
}

function persist(): void {
    if (state) save(KEY, VERSION, state);
}

export function loadHistory(): SearchHistoryData {
    return read();
}

export function recordRun(id: string): void {
    const s = read();
    s.recent = [id, ...s.recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
    s.usage[id] = (s.usage[id] ?? 0) + 1;
    // Prune the usage map if it grows unbounded, keeping the most-used entries.
    const ids = Object.keys(s.usage);
    if (ids.length > USAGE_MAX) {
        const kept = ids.sort((a, b) => s.usage[b] - s.usage[a]).slice(0, USAGE_MAX);
        const next: Record<string, number> = {};
        for (const k of kept) next[k] = s.usage[k];
        s.usage = next;
    }
    persist();
}

export function recordQuery(q: string): void {
    const s = read();
    if (!s.enabled) return;
    const t = q.trim();
    if (!t) return;
    s.queries = [t, ...s.queries.filter((x) => x !== t)].slice(0, QUERY_MAX);
    persist();
}

export function removeRecent(id: string): void {
    const s = read();
    s.recent = s.recent.filter((x) => x !== id);
    delete s.usage[id];
    persist();
}

export function togglePin(id: string): boolean {
    const s = read();
    const has = s.pinned.includes(id);
    s.pinned = has ? s.pinned.filter((x) => x !== id) : [...s.pinned, id];
    persist();
    return !has;
}

export function isPinned(id: string): boolean {
    return read().pinned.includes(id);
}

export function clearHistory(): void {
    state = empty();
    persist();
}

export function setHistoryEnabled(on: boolean): void {
    const s = read();
    s.enabled = on;
    if (!on) s.queries = [];
    persist();
}

// Snapshot the ranking-relevant signals. Rebuilt cheaply from the mirror; callers memoise per query.
export function rankSignals(extra?: Partial<RankSignals>): RankSignals {
    const s = read();
    return {
        usage: new Map(Object.entries(s.usage)),
        recent: s.recent,
        pinned: new Set(s.pinned),
        ...extra,
    };
}
