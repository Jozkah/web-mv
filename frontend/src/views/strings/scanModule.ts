import type { AxClient } from "../../transport/AxClient";
import { read } from "../../protocol/requests";
import { extractStrings, type StringEntry } from "./extractStrings";

// Orchestrates reading a module's entire address space in chunks and extracting
// every string from the raw bytes. Uses the existing `read()` protocol command -
// no new agent endpoint required. Supports cancellation via an AbortSignal so the
// user can stop a long scan mid-flight.

const CHUNK_SIZE = 0x10000; // 64 KB per read request

export interface ScanProgress {
    /** Fraction 0..1 of the module bytes read so far. */
    fraction: number;
    /** Running total of strings found so far. */
    found: number;
}

/**
 * Read a module's memory in 64KB chunks and extract all strings. Yields progress
 * updates so the caller can drive a progress bar. Returns the combined string list.
 *
 * Throws if the scan is cancelled (AbortError) or the agent errors fatally.
 */
export async function scanModuleStrings(
    client: AxClient,
    moduleBase: string,
    moduleSize: number,
    minLength: number,
    signal: AbortSignal,
    onProgress: (p: ScanProgress) => void,
): Promise<StringEntry[]> {
    const base = BigInt(moduleBase);
    const totalBytes = moduleSize;
    const results: StringEntry[] = [];
    let bytesRead = 0;

    while (bytesRead < totalBytes) {
        if (signal.aborted) throw new DOMException("Scan cancelled", "AbortError");

        const remaining = totalBytes - bytesRead;
        const chunkSize = Math.min(CHUNK_SIZE, remaining);
        const chunkAddr = `0x${(base + BigInt(bytesRead)).toString(16)}`;

        try {
            const res = await read(client, { address: chunkAddr, size: chunkSize });
            if (res.success) {
                // Decode hex string into bytes
                const hex = res.data;
                const bytes = new Uint8Array(hex.length / 2);
                for (let i = 0; i < hex.length; i += 2) {
                    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
                }

                const chunkBase = base + BigInt(bytesRead);
                const found = extractStrings(bytes, chunkBase, minLength);
                results.push(...found);
            }
            // A failed read (unreadable region) is fine — skip it. Games often have
            // guard pages or unmapped holes inside a module's virtual range.
        } catch (e) {
            // If this is an abort, re-throw. Otherwise swallow the read error (the
            // region may be guarded/unreadable) and continue with the next chunk.
            if (signal.aborted) throw new DOMException("Scan cancelled", "AbortError");
            // Swallow individual chunk failures
        }

        bytesRead += chunkSize;
        onProgress({ fraction: bytesRead / totalBytes, found: results.length });

        // Yield to the event loop so the UI stays responsive during long scans.
        await new Promise((r) => setTimeout(r, 0));
    }

    return results;
}
