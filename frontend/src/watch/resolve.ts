import { parseAddressExpr, toHex, parseHex } from "../state/address";

// Resolve a Memory Watch address expression to an absolute address, reusing the project's existing
// BigInt address arithmetic (never JS numbers — 64-bit precision is preserved throughout). Supports:
//   - absolute hex / decimal expressions, e.g. "0x14000abcd", "140000000 + 0x28"
//   - module-relative expressions, e.g. "client.dll+0x1234", "game.exe + 16", "ntdll.dll"
// Pointer-chain expressions are intentionally NOT resolved here (no pointer scanning this phase).

export interface ResolveModuleRef {
    module: string;
    base: string;
    offset: string; // hex offset from base
}

export interface ResolveResult {
    ok: boolean;
    address?: string; // absolute, canonical hex
    moduleRef?: ResolveModuleRef; // present for module-relative expressions (portable identity)
    relocationRisk?: boolean; // true for absolute-address expressions (move on re-attach / ASLR)
    error?: string;
}

// `lookup` resolves a module name to its base (canonical hex) or undefined; the caller supplies a
// case-insensitive lookup over the current target's module list.
export function resolveWatchAddress(expression: string, lookup: (name: string) => string | undefined): ResolveResult {
    const expr = expression.trim();
    if (expr === "") return { ok: false, error: "empty expression" };

    // Absolute numeric expression first — matches the address-bar convention (a bare hex run is hex).
    const numeric = parseAddressExpr(expr);
    if (numeric !== undefined) {
        return { ok: true, address: toHex(numeric), relocationRisk: true };
    }

    // Module-relative: "<module>[ +/- <numeric expr> ]". Split at the first +/- at top level.
    const opMatch = expr.match(/[+-]/);
    const moduleName = (opMatch ? expr.slice(0, opMatch.index) : expr).trim();
    const rest = opMatch ? expr.slice(opMatch.index).trim() : "";

    if (moduleName === "") return { ok: false, error: "invalid expression" };
    const base = lookup(moduleName);
    if (!base) return { ok: false, error: `module unavailable: ${moduleName}` };

    // Compute base + offset with the shared numeric parser (rest already carries its +/- sign).
    let absolute: bigint;
    let offsetHex = "0x0";
    if (rest === "") {
        absolute = parseHex(base);
    } else {
        const combined = parseAddressExpr(`${base} ${rest}`);
        if (combined === undefined) return { ok: false, error: `invalid offset: ${rest}` };
        absolute = combined;
        offsetHex = toHex(combined - parseHex(base));
    }

    return {
        ok: true,
        address: toHex(absolute),
        moduleRef: { module: moduleName, base, offset: offsetHex },
    };
}

// Case-insensitive module-name → base lookup builder from a module list.
export function makeModuleLookup(modules: readonly { name: string; base: string }[]): (name: string) => string | undefined {
    const byLower = new Map<string, string>();
    for (const m of modules) if (!byLower.has(m.name.toLowerCase())) byLower.set(m.name.toLowerCase(), m.base);
    return (name: string) => byLower.get(name.toLowerCase());
}
