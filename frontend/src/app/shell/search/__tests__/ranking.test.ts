import { describe, expect, it } from "vitest";
import { parseQuery } from "../query";
import { matchText, scoreResult, rankResults, type RankedResult } from "../ranking";
import type { SearchGroup, SearchResult } from "../types";

function res(id: string, title: string, group: SearchGroup = "Commands", extra: Partial<SearchResult> = {}): SearchResult {
    return {
        id,
        providerId: "test",
        group,
        title,
        defaultAction: { id: "run", label: "run", run: () => {} },
        ...extra,
    };
}

describe("matchText tiers", () => {
    const tier = (q: string, target: string) => matchText(parseQuery(q), target)?.tier;

    it("exact title", () => expect(tier("open memory", "Open Memory")).toBe("exact"));
    it("prefix", () => expect(tier("cli", "client.dll")).toBe("prefix"));
    it("word-prefix at a boundary", () => expect(tier("dll", "client.dll")).toBe("word-prefix"));
    it("substring inside a word", () => expect(tier("ient", "client")).toBe("substring"));
    it("acronym from initials", () => expect(tier("gm", "Go Memory")).toBe("acronym"));
    it("ordered multi-token", () => expect(tier("open viewer", "Open Memory Viewer")).toBe("ordered"));
    it("fuzzy subsequence fallback", () => expect(tier("pn", "Open Class")).toBe("fuzzy"));
    it("returns null on no match", () => expect(matchText(parseQuery("zzz"), "Open Memory")).toBeNull());

    it("scores exact above prefix above substring above fuzzy", () => {
        const s = (q: string, t: string) => matchText(parseQuery(q), t)!.score;
        expect(s("open", "open")).toBeGreaterThan(s("open", "opener"));
        expect(s("pen", "opener")).toBeGreaterThan(s("pn", "opener"));
    });

    it("reports match ranges valid against the original title", () => {
        const m = matchText(parseQuery("dll"), "client.dll")!;
        const r = m.matches[0];
        expect("client.dll".slice(r.start, r.end)).toBe("dll");
    });

    it("matches a module by its extensionless prefix", () => {
        expect(tier("client", "client.dll")).toBe("prefix");
    });
});

describe("scoreResult", () => {
    it("requires quoted phrases and excludes negatives", () => {
        const r = res("a", "Player Manager", "Bookmarks", { keywords: "health mana" });
        expect(scoreResult(r, parseQuery('"player manager"'))).not.toBeNull();
        expect(scoreResult(r, parseQuery('"missing phrase"'))).toBeNull();
        expect(scoreResult(r, parseQuery("player -manager"))).toBeNull();
    });

    it("boosts pinned, frequent and recent results", () => {
        const r = res("x", "Scanner");
        const base = scoreResult(r, parseQuery("scanner"))!.score;
        const pinned = scoreResult(r, parseQuery("scanner"), { pinned: new Set(["x"]) })!.score;
        const used = scoreResult(r, parseQuery("scanner"), { usage: new Map([["x", 5]]) })!.score;
        const recent = scoreResult(r, parseQuery("scanner"), { recent: ["x"] })!.score;
        expect(pinned).toBeGreaterThan(base);
        expect(used).toBeGreaterThan(base);
        expect(recent).toBeGreaterThan(base);
    });

    it("penalises disabled results and matches only found in metadata", () => {
        const disabled = res("d", "Foo", "Commands", { disabled: { reason: "x" } });
        const enabled = res("e", "Foo");
        expect(scoreResult(disabled, parseQuery("foo"))!.score).toBeLessThan(scoreResult(enabled, parseQuery("foo"))!.score);

        const metaOnly = res("m", "Zzz", "Commands", { keywords: "foo" });
        const titleHit = res("t", "Foo");
        expect(scoreResult(metaOnly, parseQuery("foo"))!.score).toBeLessThan(scoreResult(titleHit, parseQuery("foo"))!.score);
    });

    it("applies a scope-exact boost", () => {
        const r = res("s", "client.dll", "Modules");
        const noScope = scoreResult(r, parseQuery("client"))!.score;
        const scoped = scoreResult(r, parseQuery("module:client"))!.score;
        expect(scoped).toBeGreaterThan(noScope);
    });
});

describe("rankResults", () => {
    const scored = (...rs: RankedResult[]) => rs;

    it("dedupes by canonical id, keeping the best score", () => {
        const out = rankResults(scored(
            { result: res("dup", "A"), score: 10, matches: [] },
            { result: res("dup", "A"), score: 50, matches: [] },
        ));
        expect(out).toHaveLength(1);
        expect(out[0].score).toBe(50);
    });

    it("keeps stable order for equal scores", () => {
        const out = rankResults(scored(
            { result: res("a", "A"), score: 10, matches: [] },
            { result: res("b", "B"), score: 10, matches: [] },
            { result: res("c", "C"), score: 10, matches: [] },
        ));
        expect(out.map((r) => r.result.id)).toEqual(["a", "b", "c"]);
    });

    it("caps per group so one source cannot fill every slot", () => {
        const modules: RankedResult[] = Array.from({ length: 20 }, (_, i) => ({
            result: res(`m${i}`, `mod${i}`, "Modules"),
            score: 100 - i,
            matches: [],
        }));
        const oneAction: RankedResult = { result: res("act", "Do", "Actions"), score: 1, matches: [] };
        const out = rankResults([...modules, oneAction], { perGroup: 6, limit: 10 });
        const moduleCount = out.slice(0, 7).filter((r) => r.result.group === "Modules").length;
        expect(moduleCount).toBeLessThanOrEqual(6);
        expect(out.some((r) => r.result.id === "act")).toBe(true);
    });

    it("honours a group filter", () => {
        const out = rankResults(scored(
            { result: res("m", "mod", "Modules"), score: 10, matches: [] },
            { result: res("a", "act", "Actions"), score: 20, matches: [] },
        ), { groupFilter: "Modules" });
        expect(out.map((r) => r.result.group)).toEqual(["Modules"]);
    });
});
