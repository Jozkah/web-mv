import { describe, expect, it } from "vitest";
import { parseQuery } from "../query";
import { rankAll } from "../engine";
import { modulesProvider } from "../providers/modules";
import { addressesProvider } from "../providers/addresses";
import type { SearchContext } from "../types";

// Lightweight fake stores exposing just the slice these two providers read.
function fakeCtx(): SearchContext {
    const stores = {
        app: {
            base: () => "0x1000",
            modules: {
                status: () => "ready",
                error: () => undefined,
                list: () => [
                    { name: "client.dll", base: "0x1000", size: 0x2000 },
                    { name: "ntdll.dll", base: "0x9000", size: 0x1000 },
                    { name: "Client.dll", base: "0x1000", size: 0x2000 }, // case-dup
                ],
                baseOf: (n: string) => (n === "client.dll" ? "0x1000" : undefined),
            },
            nav: { entries: [{ kind: "static", address: "0xabc", label: "sub_abc" }] },
        },
    };
    return {
        resolveAddress: (t: string) => (/^0x/i.test(t.replace(/\s/g, "")) ? { address: "0x1428", label: "client.dll+0x428" } : undefined),
        stores: stores as unknown as SearchContext["stores"],
    } as unknown as SearchContext;
}

describe("modulesProvider", () => {
    it("builds rich, deduped module results with a main badge and end address", () => {
        const ctx = fakeCtx();
        const out = modulesProvider.search(parseQuery("client"), ctx, new AbortController().signal) as ReturnType<typeof Array.prototype.slice> as any[];
        // case-insensitive dedupe: client.dll appears once.
        const ids = out.map((r) => r.id);
        expect(ids.filter((i: string) => i.toLowerCase() === "module:client.dll")).toHaveLength(1);
        const client = out.find((r) => r.title === "client.dll");
        expect(client.badges?.[0]?.kind).toBe("main");
        expect(client.subtitle).toContain("0x3000"); // base 0x1000 + size 0x2000
        expect(client.defaultAction.id).toBe("disasm");
        expect(client.altActions.some((a: any) => a.id === "copy-base")).toBe(true);
    });

    it("ranks an exact/extensionless module name ahead of an unrelated one", () => {
        const ctx = fakeCtx();
        const results = modulesProvider.search(parseQuery("client"), ctx, new AbortController().signal) as any[];
        const ranked = rankAll(parseQuery("client"), results, {});
        expect(ranked[0].result.title).toBe("client.dll");
    });

    it("reports unavailability when no modules are loaded", () => {
        const ctx = fakeCtx();
        (ctx.stores as any).app.modules.list = () => [];
        expect(modulesProvider.available!(ctx)).not.toBe(true);
    });
});

describe("addressesProvider", () => {
    it("synthesises direct go-to results for an address expression", () => {
        const ctx = fakeCtx();
        const out = addressesProvider.search(parseQuery("0x1400+0x28"), ctx, new AbortController().signal) as any[];
        expect(out.some((r) => r.id.startsWith("goto-static:"))).toBe(true);
        expect(out.some((r) => r.id.startsWith("goto-memory:"))).toBe(true);
        const go = out.find((r) => r.id.startsWith("goto-static:"));
        expect(go.title).toContain("client.dll+0x428");
    });

    it("surfaces recent navigation addresses", () => {
        const ctx = fakeCtx();
        const out = addressesProvider.search(parseQuery("sub"), ctx, new AbortController().signal) as any[];
        expect(out.some((r) => r.id === "recent-addr:static:0xabc")).toBe(true);
    });

    it("emits no synthetic goto for non-address text", () => {
        const ctx = fakeCtx();
        const out = addressesProvider.search(parseQuery("hello"), ctx, new AbortController().signal) as any[];
        expect(out.some((r) => r.id.startsWith("goto-"))).toBe(false);
    });
});
