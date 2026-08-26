import { describe, expect, it } from "vitest";
import { parseQuery } from "../query";
import { rankAll } from "../engine";
import type { SearchGroup, SearchResult } from "../types";

// Performance guards. Thresholds are generous (CI headroom); the point is to catch an order-of-
// magnitude regression and to record real numbers. The 100k case mirrors the functions provider's
// design: filter a large cached collection cheaply FIRST, then build results only for the matches.

function mk(id: string, title: string, group: SearchGroup = "Commands"): SearchResult {
    return { id, providerId: "p", group, title, keywords: title, defaultAction: { id: "r", label: "r", run: () => {} } };
}

describe("search performance", () => {
    it("ranks a normal result set (500) fast", () => {
        const results = Array.from({ length: 500 }, (_, i) => mk(`r${i}`, `Result item number ${i}`));
        const q = parseQuery("item 42");
        const t0 = performance.now();
        const ranked = rankAll(q, results, {});
        const ms = performance.now() - t0;
        // eslint-disable-next-line no-console
        console.log(`[perf] normal 500-result rank: ${ms.toFixed(2)}ms`);
        expect(ranked.length).toBeGreaterThan(0);
        expect(ms).toBeLessThan(50);
    });

    it("filters a 100k cached index then ranks the matches quickly", () => {
        const N = 100_000;
        const names = new Array<string>(N);
        for (let i = 0; i < N; i++) names[i] = `sub_${i.toString(16)}`;
        const q = "ab";

        const t0 = performance.now();
        // Cheap filter with a match cap — the hot path on every keystroke.
        const CAP = 50;
        const hits: SearchResult[] = [];
        for (let i = 0; i < N && hits.length < CAP; i++) {
            if (names[i].includes(q)) hits.push(mk(`fn${i}`, names[i], "Functions"));
        }
        const ranked = rankAll(parseQuery(q), hits, {});
        const ms = performance.now() - t0;
        // eslint-disable-next-line no-console
        console.log(`[perf] 100k filter+rank (${hits.length} hits): ${ms.toFixed(2)}ms`);
        expect(ranked.length).toBeGreaterThan(0);
        expect(ms).toBeLessThan(120);
    });
});
