import { z } from "zod";

// Pure parsing + address mapping for the optional Ghidra headless adapter. Two shapes (Phase 15.1):
//   * ANALYSIS export — bounded module metadata (functions/symbols/blocks) with NO pseudocode.
//   * DECOMPILE result — one explicitly-requested function's pseudocode.
// Ghidra output is STATIC analysis with provenance "Ghidra" — incomplete/incorrect/stale/mismapped is
// possible, and it never touches the target. Pure, so it is fully unit-testable without Ghidra.

export const GHIDRA_ANALYSIS_FORMAT = "web-mv.ghidra.analysis";
export const GHIDRA_DECOMPILE_FORMAT = "web-mv.ghidra.decompile";

export const ghidraAnalysisFunctionSchema = z.object({
    address: z.string(),
    name: z.string().optional(),
    signature: z.string().nullable().optional(),
    callingConvention: z.string().nullable().optional(),
    size: z.number().int().nullable().optional(),
});
export const ghidraSymbolSchema = z.object({ address: z.string(), name: z.string(), type: z.string().optional() });
export const ghidraBlockSchema = z.object({ name: z.string(), start: z.string(), size: z.number().int(), r: z.boolean().optional(), w: z.boolean().optional(), x: z.boolean().optional() });

export const ghidraAnalysisSchema = z.object({
    format: z.literal(GHIDRA_ANALYSIS_FORMAT),
    schemaVersion: z.literal(1),
    imageBase: z.string(),
    arch: z.string().nullable().optional(),
    compiler: z.string().nullable().optional(),
    blocks: z.array(ghidraBlockSchema).optional(),
    functions: z.array(ghidraAnalysisFunctionSchema),
    symbols: z.array(ghidraSymbolSchema).optional(),
    warnings: z.array(z.string()).optional(),
    truncated: z.boolean().optional(),
});
export type GhidraAnalysis = z.infer<typeof ghidraAnalysisSchema>;

export const ghidraDecompileSchema = z.object({
    format: z.literal(GHIDRA_DECOMPILE_FORMAT),
    schemaVersion: z.literal(1),
    functionEntry: z.string(),
    functionName: z.string().optional(),
    signature: z.string().nullable().optional(),
    callingConvention: z.string().nullable().optional(),
    cText: z.string(),
    warnings: z.array(z.string()).optional(),
    timedOut: z.boolean().optional(),
    truncated: z.boolean().optional(),
    found: z.boolean().optional(),
    error: z.string().optional(),
});
export type GhidraDecompile = z.infer<typeof ghidraDecompileSchema>;

export function parseGhidraAnalysis(text: string): GhidraAnalysis {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("ghidra analysis: not valid JSON");
    }
    const res = ghidraAnalysisSchema.safeParse(parsed);
    if (!res.success) throw new Error(`ghidra analysis: schema mismatch (${res.error.issues[0]?.message ?? "invalid"})`);
    return res.data;
}

export function parseGhidraDecompile(text: string): GhidraDecompile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("ghidra decompile: not valid JSON");
    }
    const res = ghidraDecompileSchema.safeParse(parsed);
    if (!res.success) throw new Error(`ghidra decompile: schema mismatch (${res.error.issues[0]?.message ?? "invalid"})`);
    return res.data;
}

// A decompile target is only ever a plain hex address — never a name/path/command (defense in depth;
// the relay validates independently).
export function isValidFunctionEntry(entry: string): boolean {
    return /^0x[0-9a-f]{1,16}$/i.test(entry.trim());
}

export type MappingConfidence = "exact" | "derived" | "unmapped";

// Map a Ghidra address (relative to the loaded image base `fromBase`) into the LIVE address space
// (`toBase` = the module's current base). Undefined if below the image base or unparseable — a mismap
// is reported, never silently guessed.
export function mapAddress(addr: string, fromBase: string, toBase: string): string | undefined {
    let a: bigint;
    let from: bigint;
    let to: bigint;
    try {
        a = BigInt(addr);
        from = BigInt(fromBase);
        to = BigInt(toBase);
    } catch {
        return undefined;
    }
    if (a < from) return undefined;
    return "0x" + (to + (a - from)).toString(16);
}

// A metadata function mapped to the live address space. Pseudocode is intentionally absent — it is
// fetched only on an explicit per-function decompile request.
export interface MappedFunction {
    ghidraAddress: string;
    liveAddress?: string;
    moduleOffset?: string; // rva within the module
    mapped: boolean;
    confidence: MappingConfidence;
    name?: string;
    signature?: string;
    callingConvention?: string;
    size?: number;
    provenance: "Ghidra";
}

export function mapAnalysis(a: GhidraAnalysis, liveBase: string, imageBaseOverride?: string): MappedFunction[] {
    const from = imageBaseOverride ?? a.imageBase;
    return a.functions.map((f) => {
        const live = mapAddress(f.address, from, liveBase);
        let offset: string | undefined;
        try {
            offset = "0x" + (BigInt(f.address) - BigInt(from)).toString(16);
        } catch {
            offset = undefined;
        }
        const identity = from === liveBase; // loaded at the live base → address is the live address
        return {
            ghidraAddress: f.address,
            liveAddress: live,
            moduleOffset: offset,
            mapped: live !== undefined,
            confidence: live === undefined ? "unmapped" : identity ? "exact" : "derived",
            name: f.name,
            signature: f.signature ?? undefined,
            callingConvention: f.callingConvention ?? undefined,
            size: f.size ?? undefined,
            provenance: "Ghidra" as const,
        };
    });
}
