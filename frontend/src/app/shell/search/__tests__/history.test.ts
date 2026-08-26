import { beforeEach, describe, expect, it, vi } from "vitest";

// A minimal localStorage stand-in for the node test environment.
function installStorage(seed: Record<string, string> = {}) {
    const map = new Map<string, string>(Object.entries(seed));
    const storage = {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
    };
    (globalThis as unknown as { localStorage: typeof storage }).localStorage = storage;
    return map;
}

async function freshHistory(seed?: Record<string, string>) {
    installStorage(seed);
    vi.resetModules();
    return import("../history");
}

describe("search history", () => {
    beforeEach(() => installStorage());

    it("migrates the legacy ax.palette.recent list on first load", async () => {
        const legacy = JSON.stringify({ v: 1, data: ["action:goto", "view:memory"] });
        const h = await freshHistory({ "ax.palette.recent": legacy });
        expect(h.loadHistory().recent).toEqual(["action:goto", "view:memory"]);
    });

    it("records runs with MRU order and usage counts", async () => {
        const h = await freshHistory();
        h.recordRun("a");
        h.recordRun("b");
        h.recordRun("a");
        const data = h.loadHistory();
        expect(data.recent).toEqual(["a", "b"]);
        expect(data.usage["a"]).toBe(2);
        expect(data.usage["b"]).toBe(1);
    });

    it("pins and unpins, and removes from recent", async () => {
        const h = await freshHistory();
        h.recordRun("x");
        expect(h.togglePin("x")).toBe(true);
        expect(h.isPinned("x")).toBe(true);
        expect(h.togglePin("x")).toBe(false);
        h.removeRecent("x");
        expect(h.loadHistory().recent).not.toContain("x");
    });

    it("does not store queries when persistence is disabled", async () => {
        const h = await freshHistory();
        h.setHistoryEnabled(false);
        h.recordQuery("secret");
        expect(h.loadHistory().queries).toHaveLength(0);
    });

    it("drops malformed persisted entries on load", async () => {
        const bad = JSON.stringify({ v: 2, data: { usage: "nope", recent: [1, "ok", null], queries: null, pinned: ["p"], enabled: "x" } });
        const h = await freshHistory({ "ax.search.history": bad });
        const d = h.loadHistory();
        expect(d.recent).toEqual(["ok"]);
        expect(d.pinned).toEqual(["p"]);
        expect(d.enabled).toBe(true);
        expect(typeof d.usage).toBe("object");
    });

    it("exposes ranking signals from stored state", async () => {
        const h = await freshHistory();
        h.recordRun("z");
        h.togglePin("z");
        const sig = h.rankSignals();
        expect(sig.usage?.get("z")).toBe(1);
        expect(sig.pinned?.has("z")).toBe(true);
        expect(sig.recent).toContain("z");
    });
});
