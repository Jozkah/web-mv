import type { Instruction } from "../../../protocol/types";
import { sigScanIda } from "../../../protocol/requests";
import type { AxClient } from "../../../transport/AxClient";
import { parseHex } from "../../../state/address";

export interface SigOptions {
    wildcardRip: boolean;
    wildcardCalls: boolean;
    wildcardImmediates: boolean;
}

export const DEFAULT_SIG_OPTIONS: SigOptions = {
    wildcardRip: true,
    wildcardCalls: true,
    wildcardImmediates: false,
};

export interface AnalyzedByte {
    hex: string;
    isWildcard: boolean;
    reason?: string;
}

export interface AnalyzedInstruction {
    address: string;
    length: number;
    text: string;
    bytes: AnalyzedByte[];
}

export type SigFormat = "ida" | "cpp_str" | "cpp_array" | "cpp_hexmask" | "python";

export interface SigResult {
    idaPattern: string;
    cppString: string;
    cppMask: string;
    cppArray: string;
    cppHexMask: string;
    pythonBytes: string;
    totalBytes: number;
    wildcardCount: number;
    instructionCount: number;
}

export interface UniqueSigResult extends SigResult {
    isUnique: boolean;
    matchCount: number;
    searchDepth: number;
    error?: string;
}

/**
 * Analyzes raw instruction bytes and determines wildcard masks based on x86/x64 instruction semantics.
 */
export function analyzeInstruction(
    inst: Instruction,
    options: SigOptions = DEFAULT_SIG_OPTIONS,
): AnalyzedInstruction {
    const rawHex = inst.bytes;
    const byteHexes: string[] = [];
    for (let i = 0; i < rawHex.length; i += 2) {
        byteHexes.push(rawHex.substring(i, i + 2).toUpperCase());
    }

    const analyzed: AnalyzedByte[] = byteHexes.map((hex) => ({
        hex,
        isWildcard: false,
    }));

    const text = inst.text.trim();
    const len = byteHexes.length;
    if (len === 0) {
        return { address: inst.address, length: inst.length, text: inst.text, bytes: analyzed };
    }

    const mnemonic = text.split(/\s+/)[0]?.toLowerCase() || "";

    // 1. RIP-relative displacement wildcarding
    if (options.wildcardRip && text.toLowerCase().includes("[rip")) {
        // In x86_64, RIP-relative instructions have a 4-byte displacement (disp32).
        // If there's an immediate (e.g. `cmp dword ptr [rip+0x10], 0x1`), disp32 precedes immediate.
        // For standard instructions (`mov reg, [rip+offset]`, `lea reg, [rip+offset]`), disp32 is the last 4 bytes.
        let dispEnd = len;
        const immMatch = text.match(/,\s*(0x[0-9a-f]+|-?\d+)$/i);
        if (immMatch && len >= 5) {
            // Check if last byte/4-bytes look like immediate
            const immVal = parseInt(immMatch[1], 16);
            if (!isNaN(immVal) && immVal <= 0xff && len >= 5) {
                dispEnd = len - 1;
            } else if (!isNaN(immVal) && len >= 8) {
                dispEnd = len - 4;
            }
        }

        const dispStart = Math.max(0, dispEnd - 4);
        for (let i = dispStart; i < dispEnd && i < len; i++) {
            analyzed[i].isWildcard = true;
            analyzed[i].reason = "RIP displacement";
        }
    }

    // 2. Relative call / jmp wildcarding
    if (options.wildcardCalls && (mnemonic === "call" || mnemonic.startsWith("j"))) {
        // E8 xx xx xx xx (call rel32) or E9 xx xx xx xx (jmp rel32)
        if (len >= 5 && (byteHexes[0] === "E8" || byteHexes[0] === "E9")) {
            for (let i = 1; i <= 4 && i < len; i++) {
                analyzed[i].isWildcard = true;
                analyzed[i].reason = "Relative target";
            }
        }
        // 0F 8x xx xx xx xx (jcc rel32)
        else if (len >= 6 && byteHexes[0] === "0F" && byteHexes[1].startsWith("8")) {
            for (let i = 2; i <= 5 && i < len; i++) {
                analyzed[i].isWildcard = true;
                analyzed[i].reason = "Relative target";
            }
        }
        // EB xx (jmp rel8) or 7x xx (jcc rel8)
        else if (len === 2 && (byteHexes[0] === "EB" || byteHexes[0].startsWith("7"))) {
            analyzed[1].isWildcard = true;
            analyzed[1].reason = "Short jump target";
        }
    }

    // 3. Immediates wildcarding
    if (options.wildcardImmediates) {
        const immMatch = text.match(/,\s*(0x[0-9a-f]{2,}|-?\d+)\s*$/i);
        if (immMatch) {
            const rawVal = immMatch[1];
            let immLen = 4;
            if (rawVal.startsWith("0x")) {
                immLen = Math.max(1, Math.ceil((rawVal.length - 2) / 2));
            }
            immLen = Math.min(immLen, 4);
            // Never wildcard more bytes than are available after the opcode;
            // preserve at least the first byte (the opcode).
            immLen = Math.min(immLen, len - 1);
            if (immLen > 0) {
                for (let i = Math.max(0, len - immLen); i < len; i++) {
                    if (!analyzed[i].isWildcard) {
                        analyzed[i].isWildcard = true;
                        analyzed[i].reason = "Immediate value";
                    }
                }
            }
        }
    }

    return {
        address: inst.address,
        length: inst.length,
        text: inst.text,
        bytes: analyzed,
    };
}

/**
 * Builds a single pseudo-instruction from a raw hex-byte string (no disassembly). Every byte is
 * kept literal; the caller / user then wildcards bytes by hand via the byte-pill UI. Used for
 * signatures over data or code the disassembler did not resolve.
 */
export function analyzeRawBytes(rawHex: string, address = "0x0"): AnalyzedInstruction {
    const bytes: AnalyzedByte[] = [];
    for (let i = 0; i + 1 < rawHex.length; i += 2) {
        bytes.push({ hex: rawHex.substring(i, i + 2).toUpperCase(), isWildcard: false });
    }
    return {
        address,
        length: bytes.length,
        text: `raw data · ${bytes.length} bytes`,
        bytes,
    };
}

/** Resolves which loaded module contains an address, by base/size containment. */
export function resolveModule(
    address: string,
    modules: readonly { name: string; base: string; size: number }[],
): string | undefined {
    let a: bigint;
    try {
        a = parseHex(address);
    } catch {
        return undefined;
    }
    for (const m of modules) {
        const base = parseHex(m.base);
        if (a >= base && a < base + BigInt(m.size)) return m.name;
    }
    return undefined;
}

/**
 * Builds formatted pattern signatures from analyzed instructions.
 */
export function buildSigResult(instructions: AnalyzedInstruction[]): SigResult {
    const allBytes: AnalyzedByte[] = [];
    for (const inst of instructions) {
        allBytes.push(...inst.bytes);
    }

    const totalBytes = allBytes.length;
    const wildcardCount = allBytes.filter((b) => b.isWildcard).length;

    // 1. IDA Pattern: "48 8B 05 ?? ?? ?? ?? 48 89 5C 24 ??"
    const idaTokens = allBytes.map((b) => (b.isWildcard ? "??" : b.hex));
    const idaPattern = idaTokens.join(" ");

    // 2. C++ Pattern string: "\x48\x8B\x05\x00\x00\x00\x00" & mask "xxx????"
    const cppStr = allBytes.map((b) => `\\x${b.isWildcard ? "00" : b.hex}`).join("");
    const cppMask = allBytes.map((b) => (b.isWildcard ? "?" : "x")).join("");

    // 3. C++ Byte Array: "{ 0x48, 0x8B, 0x05, 0x00, 0x00, 0x00, 0x00 }"
    const cppArrayTokens = allBytes.map((b) => `0x${b.isWildcard ? "00" : b.hex}`);
    const cppArray = `{ ${cppArrayTokens.join(", ")} }`;

    // 4. C++ 0x?? Format: "{ 0x48, 0x8B, 0x05, 0x??, 0x??, 0x??, 0x? }"
    const cppHexMaskTokens = allBytes.map((b) => (b.isWildcard ? "0x??" : `0x${b.hex}`));
    const cppHexMask = `{ ${cppHexMaskTokens.join(", ")} }`;

    // 5. Python Bytes: b"\x48\x8B\x05\x00\x00\x00\x00"
    const pythonBytes = `b"${cppStr}"`;

    return {
        idaPattern,
        cppString: cppStr,
        cppMask,
        cppArray,
        cppHexMask,
        pythonBytes,
        totalBytes,
        wildcardCount,
        instructionCount: instructions.length,
    };
}

/**
 * Finds the shortest unique signature starting from an instruction index.
 */
export async function findShortestUniqueSig(
    client: AxClient,
    moduleName: string,
    instructions: Instruction[],
    startIndex = 0,
    options: SigOptions = DEFAULT_SIG_OPTIONS,
    maxDepth = 20,
): Promise<UniqueSigResult> {
    if (instructions.length === 0 || startIndex < 0 || startIndex >= instructions.length) {
        return {
            ...buildSigResult([]),
            isUnique: false,
            matchCount: 0,
            searchDepth: 0,
            error: "Invalid instruction list or selection start index",
        };
    }

    const analyzedList: AnalyzedInstruction[] = [];
    const end = Math.min(instructions.length, startIndex + maxDepth);

    for (let i = startIndex; i < end; i++) {
        analyzedList.push(analyzeInstruction(instructions[i], options));
        const currentSig = buildSigResult(analyzedList);

        try {
            const scanRes = await sigScanIda(client, {
                pattern: currentSig.idaPattern,
                module: moduleName,
                find_all: true,
            });

            const hits = scanRes.results || [];
            if (hits.length === 1) {
                return {
                    ...currentSig,
                    isUnique: true,
                    matchCount: 1,
                    searchDepth: analyzedList.length,
                };
            }
            if (hits.length === 0) {
                // Should not happen, but return current state
                return {
                    ...currentSig,
                    isUnique: false,
                    matchCount: 0,
                    searchDepth: analyzedList.length,
                    error: "No matches returned during live scan",
                };
            }
        } catch (err) {
            return {
                ...currentSig,
                isUnique: false,
                matchCount: 0,
                searchDepth: analyzedList.length,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // If reached max depth without reaching 1 hit
    const finalSig = buildSigResult(analyzedList);
    let finalHits = 0;
    try {
        const finalScan = await sigScanIda(client, {
            pattern: finalSig.idaPattern,
            module: moduleName,
            find_all: true,
        });
        finalHits = finalScan.results?.length || 0;
    } catch (_) {
        finalHits = 0;
    }

    return {
        ...finalSig,
        isUnique: finalHits === 1,
        matchCount: finalHits,
        searchDepth: analyzedList.length,
    };
}
