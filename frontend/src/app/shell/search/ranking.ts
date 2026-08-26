import { SEARCH_GROUPS, type ScopeName, type SearchGroup, type SearchMatch, type SearchQuery, type SearchResult } from "./types";

// Ranking. Pure, side-effect-free scoring split into a token-aware text matcher (matchText) and a
// result scorer/orderer (scoreResult / rankResults). Kept free of Date.now()/Math.random() and of
// any store access so the whole thing is deterministic and unit-testable (spec §6, §13).

export type Tier = "exact" | "prefix" | "word-prefix" | "acronym" | "ordered" | "substring" | "fuzzy";

// Base score per tier, in the priority order the spec lays out. Alias-exact sits just under an
// exact title match and is handled by the caller passing the alias text as the target.
const TIER_SCORE: Record<Tier, number> = {
    exact: 1000,
    prefix: 800,
    "word-prefix": 650,
    acronym: 520,
    ordered: 420,
    substring: 340,
    fuzzy: 260,
};

export interface TextMatch {
    tier: Tier;
    score: number;
    matches: SearchMatch[];
}

function isBoundary(t: string, idx: number): boolean {
    return idx === 0 || /[^a-z0-9]/.test(t[idx - 1]);
}

// Merge touching/overlapping ranges so highlighting renders clean contiguous spans.
function mergeRanges(ranges: SearchMatch[]): SearchMatch[] {
    if (ranges.length <= 1) return ranges;
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const out: SearchMatch[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const last = out[out.length - 1];
        if (sorted[i].start <= last.end) last.end = Math.max(last.end, sorted[i].end);
        else out.push({ ...sorted[i] });
    }
    return out;
}

// Word start indices and their initials, for acronym matching.
function wordStarts(t: string): number[] {
    const starts: number[] = [];
    for (let i = 0; i < t.length; i++) {
        if (/[a-z0-9]/.test(t[i]) && (i === 0 || /[^a-z0-9]/.test(t[i - 1]))) starts.push(i);
    }
    return starts;
}

// Score how well a query matches a single target string, choosing the best applicable tier.
// Indices in the returned matches are valid against the original target (only case was folded).
export function matchText(query: SearchQuery, target: string): TextMatch | null {
    const q = query.text.toLowerCase();
    if (!q) return null;
    const t = target.toLowerCase();
    const qNo = q.replace(/\s+/g, "");

    const candidates: TextMatch[] = [];

    if (t === q) return { tier: "exact", score: TIER_SCORE.exact, matches: [{ start: 0, end: target.length }] };

    const idx = t.indexOf(q);
    if (idx === 0) {
        candidates.push({ tier: "prefix", score: TIER_SCORE.prefix, matches: [{ start: 0, end: q.length }] });
    } else if (idx > 0) {
        const boundary = isBoundary(t, idx);
        candidates.push({
            tier: boundary ? "word-prefix" : "substring",
            score: (boundary ? TIER_SCORE["word-prefix"] : TIER_SCORE.substring) - idx * 0.3,
            matches: [{ start: idx, end: idx + q.length }],
        });
    }

    // Acronym: query (spaces removed) matches consecutive word initials.
    if (!q.includes(" ") && qNo.length >= 2) {
        const starts = wordStarts(t);
        const initials = starts.map((s) => t[s]).join("");
        const ai = initials.indexOf(qNo);
        if (ai >= 0) {
            const matches = starts.slice(ai, ai + qNo.length).map((s) => ({ start: s, end: s + 1 }));
            candidates.push({ tier: "acronym", score: TIER_SCORE.acronym, matches });
        }
    }

    // Ordered tokens: every query token appears in order (with gaps allowed).
    if (query.tokens.length > 1) {
        const matches: SearchMatch[] = [];
        let from = 0;
        let ok = true;
        let gap = 0;
        for (const tok of query.tokens) {
            const at = t.indexOf(tok, from);
            if (at < 0) {
                ok = false;
                break;
            }
            gap += at - from;
            matches.push({ start: at, end: at + tok.length });
            from = at + tok.length;
        }
        if (ok) candidates.push({ tier: "ordered", score: TIER_SCORE.ordered - gap * 0.4, matches: mergeRanges(matches) });
    }

    // Fuzzy subsequence over the space-free query.
    const fuzzy = fuzzySubsequence(qNo, t);
    if (fuzzy) candidates.push(fuzzy);

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
}

function fuzzySubsequence(q: string, t: string): TextMatch | null {
    if (!q) return null;
    const matches: SearchMatch[] = [];
    let ti = 0;
    let prev = -2;
    let gaps = 0;
    for (let qi = 0; qi < q.length; qi++) {
        let found = -1;
        for (let i = ti; i < t.length; i++) {
            if (t[i] === q[qi]) {
                found = i;
                break;
            }
        }
        if (found === -1) return null;
        if (found > prev + 1) gaps += found - (prev + 1);
        matches.push({ start: found, end: found + 1 });
        prev = found;
        ti = found + 1;
    }
    const score = TIER_SCORE.fuzzy - gaps * 2 - t.length * 0.1;
    return { tier: "fuzzy", score, matches: mergeRanges(matches) };
}

// Signals feeding the boosts/penalties. Passed in as plain data (no store handles) to keep scoring
// pure. `usage` maps a result id to how many times it has been run; `recent` is newest-first ids.
export interface RankSignals {
    usage?: Map<string, number>;
    recent?: string[];
    pinned?: Set<string>;
    activeModule?: string;
    activeTarget?: string;
    activeView?: string;
}

// Which result groups a named scope is satisfied by — used for the scope-exact boost and the
// out-of-scope penalty. A scope not listed here places no group constraint.
const SCOPE_GROUPS: Partial<Record<ScopeName, SearchGroup[]>> = {
    command: ["Commands", "Actions"],
    action: ["Actions"],
    view: ["Views"],
    theme: ["Themes"],
    module: ["Modules"],
    target: ["Targets"],
    tab: ["Tabs"],
    address: ["Addresses"],
    function: ["Functions"],
    symbol: ["Symbols"],
    bookmark: ["Bookmarks"],
    history: ["History"],
    memory: ["Memory"],
    field: ["Memory"],
    type: ["Types"],
    string: ["Strings"],
    cheat: ["Cheats"],
    scan: ["Scanner"],
    pe: ["PE"],
    region: ["Regions"],
};

export interface RankedResult {
    result: SearchResult;
    score: number;
    matches: SearchMatch[];
}

const META_ONLY_PENALTY = 120;
const DISABLED_PENALTY = 400;
const OUT_OF_SCOPE_PENALTY = 150;

export function scoreResult(result: SearchResult, query: SearchQuery, signals: RankSignals = {}): RankedResult | null {
    const titleLower = result.title.toLowerCase();
    const metaHay = [result.subtitle, result.keywords, result.hint].filter(Boolean).join(" ").toLowerCase();
    const fullHay = `${titleLower} ${metaHay} ${result.group.toLowerCase()}`;

    // Phrase requirements and negative exclusions apply to the whole haystack.
    for (const p of query.phrases) if (!fullHay.includes(p)) return null;
    for (const n of query.negatives) if (fullHay.includes(n)) return null;

    let score: number;
    let matches: SearchMatch[] = [];
    const titleM = matchText(query, result.title);
    if (titleM) {
        score = titleM.score;
        matches = titleM.matches;
    } else {
        const metaTarget = [result.keywords, result.subtitle].filter(Boolean).join(" ");
        const metaM = metaTarget ? matchText(query, metaTarget) : null;
        if (!metaM) return null;
        score = metaM.score - META_ONLY_PENALTY;
    }

    score += result.baseScore ?? 0;

    if (signals.pinned?.has(result.id)) score += 80;
    const uses = signals.usage?.get(result.id) ?? 0;
    if (uses > 0) score += Math.min(uses, 6) * 8;
    if (signals.recent) {
        const ri = signals.recent.indexOf(result.id);
        if (ri >= 0) score += Math.max(0, 30 - ri * 4);
    }
    if (signals.activeModule && fullHay.includes(signals.activeModule.toLowerCase())) score += 25;

    if (query.scope) {
        const groups = SCOPE_GROUPS[query.scope];
        if (groups) {
            if (groups.includes(result.group)) score += 60;
            else score -= OUT_OF_SCOPE_PENALTY;
        }
    }

    if (result.disabled) score -= DISABLED_PENALTY;
    else score += 10;

    return { result, score, matches };
}

const GROUP_INDEX = new Map(SEARCH_GROUPS.map((g, i) => [g, i]));

export interface RankOptions {
    limit?: number;
    perGroup?: number;
    groupFilter?: SearchGroup;
}

// Order, dedupe and cap. Dedupe is by canonical result id (highest score wins). Sort is stable:
// score desc, then group order, then original arrival index. A first pass enforces a per-group cap
// so one large source cannot fill every slot (provider diversity); a second pass fills the
// remaining capacity from the leftovers by score.
export function rankResults(scored: RankedResult[], opts: RankOptions = {}): RankedResult[] {
    const limit = opts.limit ?? 40;
    const perGroup = opts.perGroup ?? 6;

    const filtered = opts.groupFilter ? scored.filter((r) => r.result.group === opts.groupFilter) : scored;

    // Dedupe by id, keeping the best score.
    const best = new Map<string, { r: RankedResult; idx: number }>();
    filtered.forEach((r, idx) => {
        const cur = best.get(r.result.id);
        if (!cur || r.score > cur.r.score) best.set(r.result.id, { r, idx });
    });

    const unique = [...best.values()];
    unique.sort((a, b) => {
        if (b.r.score !== a.r.score) return b.r.score - a.r.score;
        const gi = (GROUP_INDEX.get(a.r.result.group) ?? 99) - (GROUP_INDEX.get(b.r.result.group) ?? 99);
        if (gi !== 0) return gi;
        return a.idx - b.idx;
    });

    const reserved: RankedResult[] = [];
    const overflow: RankedResult[] = [];
    const perGroupCount = new Map<SearchGroup, number>();
    for (const u of unique) {
        const g = u.r.result.group;
        const c = perGroupCount.get(g) ?? 0;
        if (c < perGroup) {
            perGroupCount.set(g, c + 1);
            reserved.push(u.r);
        } else {
            overflow.push(u.r);
        }
    }

    return [...reserved, ...overflow].slice(0, limit);
}
