import type { FunctionEntry } from "../protocol/types";
import { parseHex, rvaOf } from "../state/address";

export interface FunctionSigHit {
    /** Hex address of the signature match, e.g. "0x7ff612345678" */
    hitAddress: string;
    /** The containing function entry from the module, if mapped */
    function: FunctionEntry | null;
    /** Function RVA relative to module base */
    functionRva: string | null;
    /** Display name of the function (custom annotation or sub_<rva>) */
    functionName: string | null;
    /** Byte offset of the hit within the containing function (hitAddress - fn.address) */
    offset: number | null;
    /** True if hit occurs exactly at function start (+0x0) */
    isPrologue: boolean;
}

export type FunctionHitFilterMode = "all" | "mapped" | "prologue";

interface AnnotationsLike {
    nameOf(module: string, rva: string): string;
}

/**
 * Maps signature scan hit addresses against the module's enumerated functions.
 * Computes containing function start, RVA, name, and relative offset within the function.
 */
export function resolveFunctionHits(
    hitAddresses: string[],
    moduleName: string,
    moduleBase: string,
    functions: FunctionEntry[],
    annotations: AnnotationsLike,
): FunctionSigHit[] {
    if (!hitAddresses || hitAddresses.length === 0) return [];

    // Sort functions by address for binary search / linear scan
    const sortedFns = [...functions].sort((a, b) => {
        const x = parseHex(a.address);
        const y = parseHex(b.address);
        return x < y ? -1 : x > y ? 1 : 0;
    });

    return hitAddresses.map((hitAddr) => {
        const hitVal = parseHex(hitAddr);

        // Find function containing hitVal (start <= hitVal < start + size)
        const fn = sortedFns.find((f) => {
            const start = parseHex(f.address);
            const end = start + BigInt(f.size);
            return hitVal >= start && hitVal < end;
        });

        if (!fn) {
            return {
                hitAddress: hitAddr,
                function: null,
                functionRva: null,
                functionName: null,
                offset: null,
                isPrologue: false,
            };
        }

        const fnStart = parseHex(fn.address);
        const rva = rvaOf(moduleBase, fn.address);
        const name = annotations.nameOf(moduleName, rva);
        const offset = Number(hitVal - fnStart);

        return {
            hitAddress: hitAddr,
            function: fn,
            functionRva: rva,
            functionName: name,
            offset,
            isPrologue: offset === 0,
        };
    });
}

/**
 * Filter resolved function hits based on selected filter mode.
 */
export function filterFunctionHits(
    hits: FunctionSigHit[],
    mode: FunctionHitFilterMode,
): FunctionSigHit[] {
    switch (mode) {
        case "mapped":
            return hits.filter((h) => h.function !== null);
        case "prologue":
            return hits.filter((h) => h.isPrologue);
        case "all":
        default:
            return hits;
    }
}
