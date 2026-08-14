import type { ModuleEntry } from "../protocol/types";

// Render an absolute address as `module+0xRVA` when it falls inside a known module's mapped
// range, otherwise the raw hex. This is the universal address→label resolver used across views
// so a bare 0x7ff6... always reads as e.g. "GameHunt.dll+0x1a3f".

export function resolveLabel(address: string, modules: readonly ModuleEntry[]): string {
    let a: bigint;
    try {
        a = BigInt(address);
    } catch {
        return address;
    }
    for (const m of modules) {
        const base = BigInt(m.base);
        if (a >= base && a < base + BigInt(m.size)) {
            const rva = a - base;
            return `${m.name}+0x${rva.toString(16)}`;
        }
    }
    return address;
}

/** RVA within a module (without the module name), or undefined if the address isn't in it. */
export function rvaOf(address: string, module: ModuleEntry): string | undefined {
    try {
        const a = BigInt(address);
        const base = BigInt(module.base);
        if (a >= base && a < base + BigInt(module.size)) return "0x" + (a - base).toString(16);
    } catch {
        /* fall through */
    }
    return undefined;
}
