import { formatBinary, formatFloat, readString } from "./format";
import {
    isBitsType,
    isStringType,
    nodeByteSize,
    NODE_TYPES,
    type DisplayFormat,
    type Node,
} from "./types";

// Node-context-aware decoding: the registry's plain decode covers the fixed little-endian
// default, but a node can carry a display format ("dec"/"hex"/"bin"), a big-endian override,
// a string capacity, named bits, or a registry reference (enum/struct). This module resolves
// all of that into the display string. Pure: registry lookups are injected, no Solid.

/** What decodeNode needs from the dataTypes registry, injected so this stays pure/testable. */
export interface RefResolvers {
    /** Format an integer under an enum definition ("MEMBER" or "Enum(5)"), or undefined when
     *  the enum name is unknown (missing imported reference). */
    formatEnum?: (enumName: string, value: number) => string | undefined;
    /** Look up a struct definition's existence (for the structref summary cell). */
    hasStruct?: (structName: string) => boolean;
}

const bitWidth = (id: string): number =>
    id === "bits8" ? 8 : id === "bits16" ? 16 : id === "bits32" ? 32 : 64;

function getUint(view: DataView, offset: number, size: number, be: boolean): bigint {
    switch (size) {
        case 1: return BigInt(view.getUint8(offset));
        case 2: return BigInt(view.getUint16(offset, !be));
        case 4: return BigInt(view.getUint32(offset, !be));
        default: return view.getBigUint64(offset, !be);
    }
}

function getInt(view: DataView, offset: number, size: number, be: boolean): bigint {
    switch (size) {
        case 1: return BigInt(view.getInt8(offset));
        case 2: return BigInt(view.getInt16(offset, !be));
        case 4: return BigInt(view.getInt32(offset, !be));
        default: return view.getBigInt64(offset, !be);
    }
}

/** Format an integer under a display override; "auto" is the classic "dec (0xhex)" pair. */
export function formatIntAs(value: bigint, unsigned: bigint, bits: number, format: DisplayFormat): string {
    switch (format) {
        case "dec": return value.toString();
        case "hex": return `0x${unsigned.toString(16)}`;
        case "bin": return formatBinary(unsigned, bits);
        default: return `${value.toString()} (0x${unsigned.toString(16)})`;
    }
}

/** Named-bitfield rendering: fixed-width binary plus the names of the set bits. */
export function formatBits(value: bigint, bits: number, names: string[] | undefined, format: DisplayFormat): string {
    const base =
        format === "dec" ? value.toString()
        : format === "hex" ? `0x${value.toString(16)}`
        : formatBinary(value, bits);
    if (!names || names.length === 0) return base;
    const set: string[] = [];
    for (let i = 0; i < bits; i++) {
        if ((value >> BigInt(i)) & 1n) {
            const n = names[i];
            if (n) set.push(n);
        }
    }
    return set.length > 0 ? `${base} [${set.join("|")}]` : base;
}

/**
 * Decode a node's bytes into its display string, honoring the node's display format, endian
 * override, string capacity, bit names, and registry references. Returns undefined for fills,
 * out-of-bounds reads, and refs that can't be resolved into anything printable.
 */
export function decodeNode(
    view: DataView,
    offset: number,
    node: Node,
    refs: RefResolvers = {},
): string | undefined {
    const size = nodeByteSize(node);
    if (offset + size > view.byteLength) return undefined;

    const id = node.typeId;
    const be = node.endian === "be";
    const format: DisplayFormat = node.displayFormat ?? "auto";

    if (isStringType(id)) return readString(view, offset, size, id === "wstring");

    if (isBitsType(id)) {
        const bits = bitWidth(id);
        return formatBits(getUint(view, offset, bits / 8, be), bits, node.bitNames, format);
    }

    if (id === "enumref") {
        const width = Math.min(size, 8);
        if (width !== 1 && width !== 2 && width !== 4 && width !== 8) return undefined;
        const value = getInt(view, offset, width, false);
        const asNumber = Number(value);
        const named =
            node.refName && Number.isSafeInteger(asNumber)
                ? refs.formatEnum?.(node.refName, asNumber)
                : undefined;
        if (named !== undefined) {
            return format === "hex" ? `${named} (0x${getUint(view, offset, width, false).toString(16)})` : named;
        }
        // Unknown enum (missing import reference): fall back to the raw integer, flagged.
        return `${formatIntAs(value, getUint(view, offset, width, false), width * 8, format)}${node.refName ? ` (missing enum ${node.refName})` : ""}`;
    }

    if (id === "structref") {
        const name = node.refName ?? "?";
        const known = refs.hasStruct ? refs.hasStruct(name) : true;
        return known ? `struct ${name} (${size}B)` : `missing struct ${name} (${size}B)`;
    }

    switch (NODE_TYPES[id].category) {
        case "int": {
            return formatIntAs(getInt(view, offset, size, be), getUint(view, offset, size, be), size * 8, format);
        }
        case "uint": {
            const u = getUint(view, offset, size, be);
            return formatIntAs(u, u, size * 8, format);
        }
        case "float": {
            if (format === "hex") return `0x${getUint(view, offset, size, be).toString(16)}`;
            if (id === "float") {
                return formatFloat(be ? view.getFloat32(offset, false) : view.getFloat32(offset, true));
            }
            return formatFloat(be ? view.getFloat64(offset, false) : view.getFloat64(offset, true), 6);
        }
        default:
            return NODE_TYPES[id].decode(view, offset);
    }
}

/** All 16 floats of a mat4, row-major, for tooltips and the value editor's prefill. */
export function readMat4(view: DataView, offset: number): number[] | undefined {
    if (offset + 64 > view.byteLength) return undefined;
    const out: number[] = [];
    for (let i = 0; i < 16; i++) out.push(view.getFloat32(offset + i * 4, true));
    return out;
}

/** The floats of a vecN, for editor prefill. */
export function readVec(view: DataView, offset: number, count: number): number[] | undefined {
    if (offset + count * 4 > view.byteLength) return undefined;
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(view.getFloat32(offset + i * 4, true));
    return out;
}
