import { describe, expect, it } from "vitest";
import { parseQuery, hasQueryText } from "../query";

describe("parseQuery", () => {
    it("parses plain tokens", () => {
        const q = parseQuery("update player");
        expect(q.tokens).toEqual(["update", "player"]);
        expect(q.text).toBe("update player");
        expect(q.prefix).toBeUndefined();
        expect(q.scope).toBeUndefined();
    });

    it("detects a leading prefix and strips it", () => {
        expect(parseQuery("> split").prefix).toBe(">");
        expect(parseQuery("@client").prefix).toBe("@");
        expect(parseQuery("#health").prefix).toBe("#");
        expect(parseQuery("> split").text).toBe("split");
    });

    it("parses a named scope with its value", () => {
        const q = parseQuery("module:client.dll");
        expect(q.scope).toBe("module");
        expect(q.text).toBe("client.dll");
    });

    it("keeps quoted phrases intact, including inside a scope", () => {
        const q = parseQuery('bookmark:"player manager"');
        expect(q.scope).toBe("bookmark");
        expect(q.phrases).toContain("player manager");
        expect(q.text).toBe("player manager");
    });

    it("collects negative terms", () => {
        const q = parseQuery("history:scan -string");
        expect(q.scope).toBe("history");
        expect(q.negatives).toContain("string");
        expect(q.tokens).toEqual(["scan"]);
    });

    it("parses a group filter and rejects an unknown one", () => {
        expect(parseQuery("client group:modules").groupFilter).toBe("Modules");
        const bad = parseQuery("group:nope x");
        expect(bad.groupFilter).toBeUndefined();
        expect(bad.error).toMatch(/unknown group/i);
        // Plain search still survives a bad structured token.
        expect(bad.tokens).toContain("x");
    });

    it("treats an unknown key:value as an ordinary token, not a scope", () => {
        const q = parseQuery("c:foo");
        expect(q.scope).toBeUndefined();
        expect(q.tokens).toContain("c:foo");
    });

    it("preserves address expressions with + and -", () => {
        expect(parseQuery("client.dll+0x1234").text).toBe("client.dll+0x1234");
        expect(parseQuery("0x1400 + 0x28").tokens).toEqual(["0x1400", "+", "0x28"]);
    });

    it("reports empty intent for prefix-only input", () => {
        expect(hasQueryText(parseQuery(">"))).toBe(false);
        expect(hasQueryText(parseQuery(">split"))).toBe(true);
        expect(hasQueryText(parseQuery("   "))).toBe(false);
    });
});
