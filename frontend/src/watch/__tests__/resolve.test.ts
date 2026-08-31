import { describe, expect, it } from "vitest";
import { makeModuleLookup, resolveWatchAddress } from "../resolve";

const lookup = makeModuleLookup([
    { name: "client.dll", base: "0x140000000" },
    { name: "ntdll.dll", base: "0x7ffd10000000" },
]);

describe("resolveWatchAddress", () => {
    it("resolves absolute numeric expressions (flagged as relocation risk)", () => {
        const r = resolveWatchAddress("0x140000000 + 0x28", lookup);
        expect(r.ok).toBe(true);
        expect(r.address).toBe("0x140000028");
        expect(r.relocationRisk).toBe(true);
    });

    it("resolves module-relative expressions and reports module identity", () => {
        const r = resolveWatchAddress("client.dll+0x1234", lookup);
        expect(r.ok).toBe(true);
        expect(r.address).toBe("0x140001234");
        expect(r.moduleRef).toMatchObject({ module: "client.dll", offset: "0x1234" });
        expect(r.relocationRisk).toBeUndefined();
    });

    it("resolves a bare module name to its base", () => {
        const r = resolveWatchAddress("ntdll.dll", lookup);
        expect(r.address).toBe("0x7ffd10000000");
    });

    it("is case-insensitive on module name", () => {
        expect(resolveWatchAddress("Client.DLL + 16", lookup).address).toBe("0x140000010");
    });

    it("fails only the affected expression on an unknown module", () => {
        const r = resolveWatchAddress("missing.dll+0x10", lookup);
        expect(r.ok).toBe(false);
        expect(r.error).toContain("module unavailable");
    });

    it("rejects empty / malformed input without reinterpreting it", () => {
        expect(resolveWatchAddress("", lookup).ok).toBe(false);
        expect(resolveWatchAddress("client.dll + zzz", lookup).ok).toBe(false);
    });
});
