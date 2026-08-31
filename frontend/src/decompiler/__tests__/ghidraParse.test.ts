import { describe, expect, it } from "vitest";
import { isValidFunctionEntry, mapAddress, mapAnalysis, parseGhidraAnalysis, parseGhidraDecompile, type GhidraAnalysis } from "../ghidraParse";
import { GHIDRA_DEFAULTS, validateGhidraConfig } from "../../state/ghidraConfig";

const analysis: GhidraAnalysis = {
    format: "web-mv.ghidra.analysis",
    schemaVersion: 1,
    imageBase: "0x140000000",
    arch: "x86:LE:64:default",
    functions: [
        { address: "0x140001000", name: "main", signature: "int main(void)", callingConvention: "__fastcall", size: 32 },
        { address: "0x1400020a0", name: "helper" },
    ],
    symbols: [{ address: "0x140003000", name: "g_flag", type: "Data" }],
    warnings: [],
    truncated: false,
};

describe("parseGhidraAnalysis (metadata only)", () => {
    it("parses metadata and never carries pseudocode", () => {
        const a = parseGhidraAnalysis(JSON.stringify(analysis));
        expect(a.functions.length).toBe(2);
        expect((a.functions[0] as unknown as Record<string, unknown>).pseudocode).toBeUndefined();
        expect(() => parseGhidraAnalysis(JSON.stringify({ ...analysis, format: "wrong" }))).toThrow();
    });
});

describe("mapAnalysis", () => {
    it("maps to live addresses with confidence and no pseudocode", () => {
        const mapped = mapAnalysis(analysis, "0x7ff600000000", "0x140000000");
        expect(mapped[0].liveAddress).toBe("0x7ff600001000");
        expect(mapped[0].confidence).toBe("derived");
        expect(mapped[0].provenance).toBe("Ghidra");
        expect((mapped[0] as unknown as Record<string, unknown>).pseudocode).toBeUndefined();
    });
    it("identity mapping is 'exact' and below-base is 'unmapped'", () => {
        const same = mapAnalysis(analysis, "0x140000000", "0x140000000");
        expect(same[0].confidence).toBe("exact");
        const bad = mapAnalysis({ ...analysis, functions: [{ address: "0x10" }] }, "0x7ff600000000", "0x140000000");
        expect(bad[0].mapped).toBe(false);
        expect(bad[0].confidence).toBe("unmapped");
    });
    it("mapAddress rebases and rejects below-base", () => {
        expect(mapAddress("0x140001000", "0x140000000", "0x7ff600000000")).toBe("0x7ff600001000");
        expect(mapAddress("0x100", "0x140000000", "0x7ff600000000")).toBeUndefined();
    });
});

describe("parseGhidraDecompile", () => {
    it("parses a single-function decompile result", () => {
        const d = parseGhidraDecompile(JSON.stringify({ format: "web-mv.ghidra.decompile", schemaVersion: 1, functionEntry: "0x140001000", functionName: "main", cText: "int main(){}", warnings: [], timedOut: false, truncated: false, found: true }));
        expect(d.functionName).toBe("main");
        expect(d.cText).toContain("main");
    });
});

describe("isValidFunctionEntry (injection defense)", () => {
    it("accepts only plain hex addresses", () => {
        expect(isValidFunctionEntry("0x140001000")).toBe(true);
        expect(isValidFunctionEntry("main")).toBe(false);
        expect(isValidFunctionEntry("0x1000; rm -rf /")).toBe(false);
        expect(isValidFunctionEntry("../etc")).toBe(false);
    });
});

describe("validateGhidraConfig", () => {
    it("requires a path when enabled", () => {
        expect(validateGhidraConfig({ ...GHIDRA_DEFAULTS })).toEqual([]);
        expect(validateGhidraConfig({ ...GHIDRA_DEFAULTS, enabled: true })).toContain("analyzeHeadless path is required to enable Ghidra");
    });
});
