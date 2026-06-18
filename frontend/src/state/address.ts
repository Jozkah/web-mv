// Address arithmetic. Agent addresses are lowercase, unpadded hex strings ("0x%llx")
// that can exceed 2^53, so we go through BigInt - never JS numbers - for any math.
//
// RVA (offset from module base) is the stable identity we hang annotations on: an
// absolute VA moves when the process re-attaches (ASLR), but a function's RVA does not.

export function parseHex(hex: string): bigint {
    return BigInt(hex);
}

/**
 * Parse an address expression into an absolute value: one or more numeric terms joined by
 * `+` / `-`, so a base can be offset right in the address bar, e.g. "0x4a486a8d000 + 0x28"
 * or "0x140000000 - 16". A term is hex when it starts with `0x` or contains a hex digit
 * (a-f); a bare run of decimal digits is decimal. Returns undefined on malformed input or a
 * negative result.
 */
export function parseAddressExpr(text: string): bigint | undefined {
    const compact = text.replace(/\s+/g, "");
    if (!compact) return undefined;

    const terms = compact.match(/[+-]?(?:0x[0-9a-f]+|[0-9a-f]+)/gi);
    if (!terms || terms.join("") !== compact) return undefined;

    let result = 0n;
    for (const term of terms) {
        const sign = term[0] === "-" ? -1n : 1n;
        const body = term.replace(/^[+-]/, "");
        const hex = /^0x/i.test(body) || /[a-f]/i.test(body);
        try {
            result += sign * (hex ? BigInt(`0x${body.replace(/^0x/i, "")}`) : BigInt(body));
        } catch {
            return undefined;
        }
    }
    return result < 0n ? undefined : result;
}

/** Canonical lowercase, unpadded hex with 0x prefix - matches the agent's encoding. */
export function toHex(value: bigint): string {
    return `0x${value.toString(16)}`;
}

/** Offset of an absolute address from its module base, as a canonical hex string. */
export function rvaOf(base: string, address: string): string {
    return toHex(parseHex(address) - parseHex(base));
}

/** Absolute address for an RVA within a module - the inverse of rvaOf. */
export function addressOf(base: string, rva: string): string {
    return toHex(parseHex(base) + parseHex(rva));
}

/** IDA-style placeholder name for an un-renamed function, e.g. "sub_1b30". */
export function defaultName(rva: string): string {
    return `sub_${rva.startsWith("0x") ? rva.slice(2) : rva}`;
}
