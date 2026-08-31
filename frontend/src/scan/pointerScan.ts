import { buildPointerIndex, findPointerChains, type ModuleRange, type PointerChain, type PointerSlot } from "./pointerChain";

// Bounded, scoped driver for pointer-chain discovery. It builds a pointer map from a single scanned
// region (a module's mapped range, typically) by reading it in chunks through documented Angel reads,
// extracts every aligned pointer-sized slot, then runs the pure reverse search (pointerChain.ts).
// Whole-process pointer maps are impractical over the browser transport, so discovery is deliberately
// scoped and byte-budgeted — this is honest about what polling reads can do.

export interface DiscoverRegion {
    base: bigint;
    size: bigint;
}

export interface DiscoverOptions {
    target: bigint;
    region: DiscoverRegion; // the region to scan for pointer slots (e.g. a module's range)
    modules: readonly ModuleRange[]; // static roots a chain may end in
    maxDepth: number;
    maxOffset: bigint;
    maxResults: number;
    byteBudget?: number; // hard cap on bytes read (default 8 MiB)
    chunkBytes?: number; // per-read chunk (default 64 KiB — the read_batch per-entry ceiling)
}

export interface DiscoverProgress {
    bytesScanned: number;
    slots: number;
}

// `readChunk(address, size)` returns the raw little-endian bytes, or undefined on an unreadable range.
export type ChunkReader = (address: bigint, size: number) => Promise<Uint8Array | undefined>;

export interface DiscoverResult {
    chains: PointerChain[];
    bytesScanned: number;
    slots: number;
    truncated: boolean; // byte budget hit before the whole region was scanned
}

function readU64LE(bytes: Uint8Array, off: number): bigint {
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(bytes[off + i]) << BigInt(i * 8);
    return v;
}

export async function discoverPointerChains(read: ChunkReader, opts: DiscoverOptions, onProgress?: (p: DiscoverProgress) => void): Promise<DiscoverResult> {
    const chunk = opts.chunkBytes ?? 0x10000;
    const budget = opts.byteBudget ?? 8 * 1024 * 1024;
    const slots: PointerSlot[] = [];
    let bytesScanned = 0;
    let truncated = false;

    let off = 0n;
    const end = opts.region.size;
    while (off < end) {
        if (bytesScanned >= budget) { truncated = true; break; }
        const remaining = end - off;
        const size = Number(remaining < BigInt(chunk) ? remaining : BigInt(chunk));
        const base = opts.region.base + off;
        const bytes = await read(base, size);
        if (bytes && bytes.length >= 8) {
            // Aligned pointer-sized slots (8-byte stride).
            for (let i = 0; i + 8 <= bytes.length; i += 8) {
                slots.push({ slot: base + BigInt(i), value: readU64LE(bytes, i) });
            }
        }
        bytesScanned += size;
        off += BigInt(size);
        onProgress?.({ bytesScanned, slots: slots.length });
    }

    const index = buildPointerIndex(slots);
    const chains = findPointerChains(index, {
        target: opts.target,
        maxDepth: opts.maxDepth,
        maxOffset: opts.maxOffset,
        maxResults: opts.maxResults,
        modules: opts.modules,
        staticOnly: true,
    });
    return { chains, bytesScanned, slots: slots.length, truncated };
}
