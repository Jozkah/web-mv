import { describe, expect, it } from "vitest";
import { parseQuery } from "../query";
import { executeProviders, rankAll, groupResults, buildEmptyView } from "../engine";
import type { SearchContext, SearchGroup, SearchProvider, SearchResult } from "../types";
import type { RankSignals } from "../ranking";

const ctx = { stores: {} } as unknown as SearchContext;

function makeResult(id: string, title: string, group: SearchGroup = "Commands"): SearchResult {
    return { id, providerId: "p", group, title, defaultAction: { id: "run", label: "run", run: () => {} } };
}

function syncProvider(id: string, results: SearchResult[], extra: Partial<SearchProvider> = {}): SearchProvider {
    return { id, group: "Commands", maxResults: 50, search: () => results, ...extra };
}

describe("executeProviders", () => {
    it("collects sync results and caps to maxResults", () => {
        const p = syncProvider("p", [makeResult("a", "A"), makeResult("b", "B"), makeResult("c", "C")], { maxResults: 2 });
        const run = executeProviders(parseQuery("x"), ctx, [p], new AbortController().signal);
        expect(run.sync).toHaveLength(2);
        expect(run.states[0]).toEqual({ id: "p", loading: false });
    });

    it("disables a provider that is unavailable, with its reason", () => {
        const p = syncProvider("mods", [makeResult("a", "A")], { available: () => ({ reason: "detached" }) });
        const run = executeProviders(parseQuery("x"), ctx, [p], new AbortController().signal);
        expect(run.sync).toHaveLength(0);
        expect(run.states[0].error).toBe("detached");
    });

    it("survives a throwing provider without losing the others", () => {
        const bad: SearchProvider = { id: "bad", group: "Commands", maxResults: 10, search: () => { throw new Error("boom"); } };
        const good = syncProvider("good", [makeResult("g", "G")]);
        const run = executeProviders(parseQuery("x"), ctx, [bad, good], new AbortController().signal);
        expect(run.sync.map((r) => r.id)).toEqual(["g"]);
        expect(run.states.find((s) => s.id === "bad")?.error).toBe("boom");
    });

    it("marks async providers loading and resolves them under a signal", async () => {
        const async: SearchProvider = {
            id: "async",
            group: "Commands",
            maxResults: 10,
            search: async (_q, _c, signal) => {
                await Promise.resolve();
                return signal.aborted ? [] : [makeResult("z", "Z")];
            },
        };
        const run = executeProviders(parseQuery("x"), ctx, [async], new AbortController().signal);
        expect(run.states[0].loading).toBe(true);
        const res = await run.pending[0].promise;
        expect(res.map((r) => r.id)).toEqual(["z"]);
    });

    it("lets a provider cancel its own work when the signal is aborted (stale batch)", async () => {
        const controller = new AbortController();
        const async: SearchProvider = {
            id: "async",
            group: "Commands",
            maxResults: 10,
            search: async (_q, _c, signal) => {
                await Promise.resolve();
                return signal.aborted ? [] : [makeResult("z", "Z")];
            },
        };
        const run = executeProviders(parseQuery("x"), ctx, [async], controller.signal);
        controller.abort(); // a newer query arrived
        const res = await run.pending[0].promise;
        expect(res).toEqual([]);
        expect(controller.signal.aborted).toBe(true);
    });
});

describe("rankAll + groupResults", () => {
    it("ranks, limits and groups", () => {
        const results = [makeResult("a", "Scanner", "Actions"), makeResult("b", "Scan module", "Modules")];
        const ranked = rankAll(parseQuery("scan"), results, {}, 40);
        expect(ranked.length).toBe(2);
        const groups = groupResults(ranked);
        expect(groups.map((g) => g.group).sort()).toEqual(["Actions", "Modules"]);
    });
});

describe("buildEmptyView", () => {
    it("splits favorites, recent and suggestions", () => {
        const items = [makeResult("p1", "Pinned"), makeResult("r1", "Recent one"), makeResult("s1", "Suggestion", "Views")];
        const provider = syncProvider("p", items, { emptyResults: true });
        const signals: RankSignals = { pinned: new Set(["p1"]), recent: ["r1", "p1"] };
        const ev = buildEmptyView(ctx, [provider], parseQuery(""), signals, new AbortController().signal);
        expect(ev.favorites.map((r) => r.id)).toEqual(["p1"]);
        expect(ev.recent.map((r) => r.id)).toEqual(["r1"]);
        expect(ev.suggestions.some((g) => g.items.some((i) => i.result.id === "s1"))).toBe(true);
    });
});
