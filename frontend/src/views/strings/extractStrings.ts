// Client-side string extraction from raw memory bytes. Walks a buffer looking for
// printable ASCII and UTF-16LE runs - the same heuristic IDA applies when you open
// its Strings window. Each discovered string is emitted as a StringEntry.
//
// ASCII: a run of ≥ minLength bytes in 0x20..0x7E (plus tab/CR/LF), terminated by
// a NUL (0x00) or a non-printable byte.
// UTF-16LE: a run of ≥ minLength wchar pairs where the low byte is printable and the
// high byte is 0x00, terminated by 0x0000 or a non-qualifying pair.

export type StringCategory = "url" | "path" | "cmd" | "rtti" | "other";

export interface StringEntry {
    /** Absolute hex address where the string starts. */
    address: string;
    /** The decoded string value. */
    value: string;
    /** Byte length of the string in memory (excluding terminator). */
    length: number;
    /** Character count. */
    charCount: number;
    /** Detection type. */
    type: "ascii" | "utf16";
    /** Categorization tag. */
    category: StringCategory;
}

export function classifyString(v: string): StringCategory {
    const lower = v.toLowerCase();
    if (lower.includes("http://") || lower.includes("https://") || lower.includes(".com/") || lower.includes("/api/")) {
        return "url";
    }
    if (
        lower.includes("/") ||
        lower.includes("\\") ||
        /\.(lua|vfx|png|json|dll|exe|cfg|txt|bin|dat|xml|wav|mp3|ogg|bmp|tga|dds|pfb)$/i.test(v)
    ) {
        return "path";
    }
    if (
        v.includes("%s") ||
        v.includes("%d") ||
        v.includes("%f") ||
        v.includes("%x") ||
        v.startsWith("cmd_") ||
        v.startsWith("sv_") ||
        v.startsWith("cl_") ||
        v.startsWith("cvar_")
    ) {
        return "cmd";
    }
    if (
        v.startsWith("class ") ||
        v.startsWith("struct ") ||
        v.startsWith("namespace ") ||
        v.includes("::") ||
        v.startsWith("type_info")
    ) {
        return "rtti";
    }
    return "other";
}

function isPrintable(c: number): boolean {
    return (c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d;
}

/**
 * Extract all strings from a byte buffer starting at the given base address.
 * Returns the discovered strings sorted by address.
 */
export function extractStrings(
    bytes: Uint8Array,
    baseAddress: bigint,
    minLength: number,
): StringEntry[] {
    const results: StringEntry[] = [];

    // --- UTF-16LE pass (first, so we don't misidentify wide strings as short ASCII) ---
    const claimed = new Uint8Array(bytes.length); // 1 = claimed by UTF-16
    {
        let i = 0;
        while (i + 1 < bytes.length) {
            if (isPrintable(bytes[i]) && bytes[i + 1] === 0) {
                const start = i;
                let chars = 0;
                while (
                    i + 1 < bytes.length &&
                    isPrintable(bytes[i]) &&
                    bytes[i + 1] === 0
                ) {
                    chars++;
                    i += 2;
                }
                // Check for NUL terminator (0x0000) or end-of-buffer
                const terminated =
                    i + 1 >= bytes.length ||
                    (bytes[i] === 0 && bytes[i + 1] === 0);
                if (chars >= minLength && terminated) {
                    // Decode the wide string
                    const codeUnits: number[] = [];
                    for (let k = start; k < start + chars * 2; k += 2) {
                        codeUnits.push(bytes[k] | (bytes[k + 1] << 8));
                    }
                    const value = String.fromCharCode(...codeUnits);
                    const addr = baseAddress + BigInt(start);
                    results.push({
                        address: `0x${addr.toString(16)}`,
                        value,
                        length: chars * 2,
                        charCount: chars,
                        type: "utf16",
                        category: classifyString(value),
                    });
                    // Mark these bytes as claimed
                    for (let k = start; k < i; k++) claimed[k] = 1;
                }
            } else {
                i++;
            }
        }
    }

    // --- ASCII pass ---
    {
        let i = 0;
        while (i < bytes.length) {
            if (claimed[i] === 0 && isPrintable(bytes[i])) {
                const start = i;
                while (i < bytes.length && claimed[i] === 0 && isPrintable(bytes[i])) {
                    i++;
                }
                // Check for NUL terminator or end-of-buffer
                const terminated = i >= bytes.length || bytes[i] === 0;
                const charCount = i - start;
                if (charCount >= minLength && terminated) {
                    const value = new TextDecoder("ascii").decode(
                        bytes.subarray(start, i),
                    );
                    const addr = baseAddress + BigInt(start);
                    results.push({
                        address: `0x${addr.toString(16)}`,
                        value,
                        length: charCount,
                        charCount,
                        type: "ascii",
                        category: classifyString(value),
                    });
                }
            } else {
                i++;
            }
        }
    }

    // Sort by address
    results.sort((a, b) => {
        if (a.address.length !== b.address.length) return a.address.length - b.address.length;
        return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    });

    return results;
}
