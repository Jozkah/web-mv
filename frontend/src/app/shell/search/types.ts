// The universal-search type system. These interfaces are the contract between the CommandPalette
// (query state, rendering, keyboard) and the independent search providers (one per application
// entity). Nothing here imports a store or a view component: providers receive everything they
// need through SearchContext, so the search layer stays decoupled from the rest of the app.

import type { NavKind } from "../../../state/navStore";

// Result groups. This is the extensible list the spec calls for: every provider declares one, and
// new providers add a member here rather than widening an ad-hoc union at each call site. Ordered
// roughly by how a user expects them ranked when scores tie.
export const SEARCH_GROUPS = [
    "Favorites",
    "Recent",
    "Commands",
    "Views",
    "Actions",
    "Themes",
    "Targets",
    "Tabs",
    "Modules",
    "Functions",
    "Symbols",
    "Addresses",
    "Bookmarks",
    "Memory",
    "Types",
    "Cheats",
    "Strings",
    "Scanner",
    "PE",
    "Regions",
    "History",
] as const;

export type SearchGroup = (typeof SEARCH_GROUPS)[number];

// Named scopes the query language understands (`module:`, `bookmark:` …). Kept as data so the
// parser, the chip UI and provider routing all read the same source.
export const SCOPES = [
    "command",
    "view",
    "action",
    "theme",
    "module",
    "target",
    "tab",
    "address",
    "function",
    "symbol",
    "bookmark",
    "history",
    "memory",
    "field",
    "type",
    "string",
    "cheat",
    "scan",
    "pe",
    "region",
] as const;

export type ScopeName = (typeof SCOPES)[number];

export type Prefix = ">" | "@" | "#";

// A parsed query. `text` is the residual free text once a prefix/scope was stripped; providers rank
// against it. `tokens`/`phrases`/`negatives` are the tokenised form used by ranking. `groupFilter`
// comes from an explicit `group:` filter. Structured-syntax errors surface in `error` without
// preventing a plain fuzzy fallback.
export interface SearchQuery {
    raw: string;
    text: string;
    tokens: string[];
    phrases: string[];
    negatives: string[];
    prefix?: Prefix;
    scope?: ScopeName;
    groupFilter?: SearchGroup;
    error?: string;
}

// A contiguous [start, end) highlight range within a result's title.
export interface SearchMatch {
    start: number;
    end: number;
}

export interface SearchBadge {
    label: string;
    kind?: "main" | "attached" | "stale" | "info";
}

export interface PreviewData {
    title: string;
    rows: { label: string; value: string }[];
    body?: string;
}

// One executable action on a result. `kind: "destructive"` is never run by a bare Enter (the
// palette forces explicit selection or confirmation); `kind: "split"` opens in a side split.
export interface SearchAction {
    id: string;
    label: string;
    icon?: string;
    kind?: "default" | "split" | "destructive";
    // Return value is ignored (many store setters return their new value); callers `void` it. Async
    // actions may return a promise, which the palette does not await.
    run: (ctx: SearchContext) => unknown;
}

export interface SearchResult {
    id: string;
    providerId: string;
    group: SearchGroup;
    title: string;
    subtitle?: string;
    hint?: string;
    icon?: string;
    badges?: SearchBadge[];
    kbd?: string;
    keywords?: string;
    // A provider-supplied base score; ranking adds tier scores and boosts on top. Optional.
    baseScore?: number;
    // A recency/priority nudge for empty-query ordering (higher = earlier).
    boost?: number;
    matches?: SearchMatch[];
    defaultAction: SearchAction;
    altActions?: SearchAction[];
    disabled?: { reason: string };
    preview?: (signal: AbortSignal) => PreviewData | Promise<PreviewData>;
}

// What a provider can reach. Deliberately a flat bag of accessors and helpers rather than the
// concrete stores, so providers never import view components and cannot be broken by store-shape
// churn. CommandPalette builds this once from the live contexts.
export interface SearchContext {
    // Navigation + address helpers.
    goto: (kind: NavKind, address: string, label?: string) => void;
    resolveAddress: (text: string) => { address: string; label: string } | undefined;
    // Module lookup used by many providers for label resolution.
    moduleBase: (name: string) => string | undefined;
    // Clipboard, resilient to failure.
    copy: (text: string) => Promise<boolean>;
    // View / tab helpers.
    openView: (kind: string, focusId?: string) => void;
    openSideSplit: (kind: string) => void;
    // Diagnostics flag (dev only) — providers/ranking may attach debug info when true.
    debug: boolean;
    // The live store bag, injected by CommandPalette. Loosely typed on purpose: each provider
    // narrows the slice it needs. Avoids a hard dependency graph through this file.
    stores: SearchStores;
}

// The provider-visible surface of the app's stores. Kept as `unknown`-friendly accessors that the
// palette fills in; providers cast the slice they use. This is the one seam where the search layer
// touches app state, and it is read-only from the providers' side.
export interface SearchStores {
    [key: string]: unknown;
}

export interface SearchProvider {
    id: string;
    group: SearchGroup;
    // Alias words that route a bare query to this provider and boost its results.
    keywords?: string[];
    // Named scopes this provider answers (e.g. "module"). Used for `scope:` routing.
    scopes?: ScopeName[];
    // Prefix this provider answers (`>` `@` `#`).
    prefix?: Prefix;
    // Whether the provider contributes results to an empty query (recents, suggestions).
    emptyResults?: boolean;
    // Upper bound on results this provider returns per search — keeps one large source in check.
    maxResults: number;
    // Availability gate. Returning a reason disables (rather than hides) the provider's slot with
    // an explanation; returning true/undefined means available.
    available?: (ctx: SearchContext) => true | { reason: string };
    // The search itself. May be sync (returns array) or async (returns promise). Async providers
    // receive an AbortSignal and MUST honour it: a stale search must never replace newer results.
    search: (
        query: SearchQuery,
        ctx: SearchContext,
        signal: AbortSignal,
    ) => SearchResult[] | Promise<SearchResult[]>;
}

// Per-provider execution state surfaced to the UI (loading spinner, error line).
export interface SearchProviderState {
    id: string;
    loading: boolean;
    error?: string;
}
