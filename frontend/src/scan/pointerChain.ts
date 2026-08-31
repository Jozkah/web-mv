// Pure reverse pointer-chain search. Given a pointer map (every readable pointer-sized slot and the
// value it holds) and the module (static) ranges, find chains base + [o1] + [o2] + ... that resolve
// to a target address, up to a bounded depth and per-hop offset. This is angel-derived: the pointer
// map is built from documented Angel reads by the caller; this module is the pure algorithm, so it is
// exhaustively unit-testable and never touches the transport itself.
//
// It is a heuristic discovery over a memory SNAPSHOT — a found chain is only as stable as the pointers
// were at scan time. Whole-process pointer maps are large; the caller bounds the scanned region.

export interface PointerSlot {
    slot: bigint; // address of the pointer-sized slot
    value: bigint; // the pointer value stored there
}

export interface ModuleRange {
    name: string;
    base: bigint;
    size: bigint;
}

export interface PointerChain {
    baseModule?: string; // static module the chain roots in (undefined = rooted at a raw static addr)
    baseRva?: string; // hex offset of the base within its module
    baseAddress: string; // absolute base address (hex)
    offsets: string[]; // hex offsets applied in order from base down to the target
    depth: number;
}

// A value-indexed pointer map for range queries ("which slots hold a value in [lo, hi]").
export interface PointerIndex {
    // slots sorted ascending by value, with parallel value array for binary search.
    values: bigint[];
    slots: bigint[];
}

export function buildPointerIndex(entries: readonly PointerSlot[]): PointerIndex {
    const sorted = [...entries].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    return { values: sorted.map((e) => e.value), slots: sorted.map((e) => e.slot) };
}

// Lower-bound binary search: first index whose value >= x.
function lowerBound(values: readonly bigint[], x: bigint): number {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[mid] < x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// Slots whose stored value is in [lo, hi] (inclusive). Bounded by `cap` results.
export function slotsWithValueInRange(index: PointerIndex, lo: bigint, hi: bigint, cap: number): PointerSlot[] {
    const out: PointerSlot[] = [];
    let i = lowerBound(index.values, lo);
    while (i < index.values.length && index.values[i] <= hi && out.length < cap) {
        out.push({ slot: index.slots[i], value: index.values[i] });
        i++;
    }
    return out;
}

function toHex(v: bigint): string {
    return "0x" + v.toString(16);
}

// Locate the static module a raw address falls in.
function staticModule(ranges: readonly ModuleRange[], addr: bigint): ModuleRange | undefined {
    for (const m of ranges) if (addr >= m.base && addr < m.base + m.size) return m;
    return undefined;
}

export interface PointerScanOptions {
    target: bigint;
    maxDepth: number; // number of pointer hops (1..~6)
    maxOffset: bigint; // largest positive offset per hop
    maxResults: number; // hard cap on emitted chains
    maxFrontier?: number; // hard cap on the search frontier per level (prevents blow-up)
    modules: readonly ModuleRange[];
    // When true, only emit chains rooted inside a module (the usual "static base" requirement).
    staticOnly?: boolean;
}

interface Node {
    addr: bigint;
    offsets: bigint[]; // offsets from this addr down to target, in order
}

// Reverse BFS from the target: at each level, find slots whose value points within `maxOffset` below
// an address in the frontier; a slot rooted in a module yields a chain. Deterministic and bounded.
export function findPointerChains(index: PointerIndex, opts: PointerScanOptions): PointerChain[] {
    const maxFrontier = opts.maxFrontier ?? 20000;
    const chains: PointerChain[] = [];
    const seen = new Set<string>();

    let frontier: Node[] = [{ addr: opts.target, offsets: [] }];

    for (let depth = 1; depth <= opts.maxDepth && chains.length < opts.maxResults; depth++) {
        const next: Node[] = [];
        for (const node of frontier) {
            if (chains.length >= opts.maxResults) break;
            const lo = node.addr > opts.maxOffset ? node.addr - opts.maxOffset : 0n;
            const hits = slotsWithValueInRange(index, lo, node.addr, opts.maxResults * 4);
            for (const h of hits) {
                if (chains.length >= opts.maxResults) break;
                const offset = node.addr - h.value;
                const offsets = [offset, ...node.offsets];
                const mod = staticModule(opts.modules, h.slot);
                if (mod) {
                    const rva = h.slot - mod.base;
                    const key = `${mod.name}+${rva}:${offsets.join(",")}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        chains.push({ baseModule: mod.name, baseRva: toHex(rva), baseAddress: toHex(h.slot), offsets: offsets.map(toHex), depth });
                    }
                } else if (!opts.staticOnly && depth === opts.maxDepth) {
                    const key = `${h.slot}:${offsets.join(",")}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        chains.push({ baseAddress: toHex(h.slot), offsets: offsets.map(toHex), depth });
                    }
                }
                // Continue searching upward from this slot unless it is already a static root.
                if (!mod && next.length < maxFrontier) next.push({ addr: h.slot, offsets });
            }
        }
        frontier = next;
        if (frontier.length === 0) break;
    }
    return chains;
}

// Forward-resolve a discovered chain against a live reader, to verify it still lands on the target.
// `read64(addr)` returns the pointer value at addr, or undefined on an unreadable address.
export function resolveChain(baseAddress: string, offsets: readonly string[], read64: (addr: bigint) => bigint | undefined): bigint | undefined {
    let cur = BigInt(baseAddress);
    for (let i = 0; i < offsets.length; i++) {
        const ptr = read64(cur);
        if (ptr === undefined) return undefined;
        cur = ptr + BigInt(offsets[i]);
    }
    return cur;
}
