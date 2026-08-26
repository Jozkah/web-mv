import type { RankedResult, RankSignals } from "./ranking";
import { rankResults, scoreResult } from "./ranking";
import type { SearchContext, SearchGroup, SearchProvider, SearchProviderState, SearchQuery, SearchResult } from "./types";

// The search engine: coordination between the parsed query, the providers and the ranker. Providers
// may be synchronous (return an array — the common, instant path) or asynchronous (return a promise).
// Async results are gathered under an AbortSignal; the palette tags each run with a generation token
// so a stale async batch is dropped rather than replacing newer results (spec §1, §10).

export interface ProviderRun {
    // Results available synchronously this tick.
    sync: SearchResult[];
    // Async providers still resolving; each promise honours the abort signal.
    pending: { id: string; promise: Promise<SearchResult[]> }[];
    states: SearchProviderState[];
}

export function executeProviders(
    query: SearchQuery,
    ctx: SearchContext,
    providers: SearchProvider[],
    signal: AbortSignal,
): ProviderRun {
    const sync: SearchResult[] = [];
    const pending: { id: string; promise: Promise<SearchResult[]> }[] = [];
    const states: SearchProviderState[] = [];

    for (const p of providers) {
        const avail = p.available?.(ctx);
        if (avail && avail !== true) {
            states.push({ id: p.id, loading: false, error: avail.reason });
            continue;
        }
        try {
            const r = p.search(query, ctx, signal);
            if (Array.isArray(r)) {
                sync.push(...r.slice(0, p.maxResults));
                states.push({ id: p.id, loading: false });
            } else {
                states.push({ id: p.id, loading: true });
                pending.push({
                    id: p.id,
                    promise: r.then((res) => res.slice(0, p.maxResults)),
                });
            }
        } catch (e) {
            // One failing provider must never break the palette.
            states.push({ id: p.id, loading: false, error: e instanceof Error ? e.message : String(e) });
        }
    }

    return { sync, pending, states };
}

// Score and order a flat result set for the current query.
export function rankAll(
    query: SearchQuery,
    results: SearchResult[],
    signals: RankSignals,
    limit = 40,
): RankedResult[] {
    const scored: RankedResult[] = [];
    for (const r of results) {
        const s = scoreResult(r, query, signals);
        if (s) scored.push(s);
    }
    return rankResults(scored, { limit, groupFilter: query.groupFilter });
}

export interface RenderGroup {
    group: SearchGroup;
    items: RankedResult[];
}

// Group ranked results by their group, preserving the ranked order of first appearance. Used to
// render group headers with counts.
export function groupResults(ranked: RankedResult[]): RenderGroup[] {
    const order: SearchGroup[] = [];
    const map = new Map<SearchGroup, RankedResult[]>();
    for (const r of ranked) {
        const g = r.result.group;
        let bucket = map.get(g);
        if (!bucket) {
            bucket = [];
            map.set(g, bucket);
            order.push(g);
        }
        bucket.push(r);
    }
    return order.map((group) => ({ group, items: map.get(group)! }));
}

// Build the empty-query view: pinned favourites first, then recents, then a bounded suggestion set
// from the empty-capable providers. Everything here is synchronous cached reads.
export interface EmptyView {
    favorites: SearchResult[];
    recent: SearchResult[];
    suggestions: RenderGroup[];
}

export function buildEmptyView(
    ctx: SearchContext,
    providers: SearchProvider[],
    query: SearchQuery,
    signals: RankSignals,
    signal: AbortSignal,
): EmptyView {
    const emptyProviders = providers.filter((p) => p.emptyResults);
    const run = executeProviders(query, ctx, emptyProviders, signal);
    const byId = new Map<string, SearchResult>();
    for (const r of run.sync) if (!byId.has(r.id)) byId.set(r.id, r);

    const pinned = signals.pinned ?? new Set<string>();
    const favorites: SearchResult[] = [];
    for (const id of pinned) {
        const r = byId.get(id);
        if (r) favorites.push(r);
    }

    const favSet = new Set(favorites.map((r) => r.id));
    const recent: SearchResult[] = [];
    for (const id of signals.recent ?? []) {
        if (favSet.has(id)) continue;
        const r = byId.get(id);
        if (r) recent.push(r);
        if (recent.length >= 8) break;
    }

    const usedIds = new Set([...favSet, ...recent.map((r) => r.id)]);
    // Suggestions: remaining empty-provider results, lightly ordered by their boost, grouped.
    const rest = run.sync
        .filter((r) => !usedIds.has(r.id))
        .sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0));
    const suggestions = groupResults(rest.map((r) => ({ result: r, score: 0, matches: [] })));

    return { favorites, recent, suggestions };
}
