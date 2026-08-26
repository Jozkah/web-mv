import { changedFromBaseline, type Baseline } from "./baseline";
import { decodeNode, type RefResolvers } from "./decode";
import { offsets } from "./layout";
import { isFill, isPointerType, nodeByteSize, NODE_TYPES, type Node } from "./types";

// Search + filtering over a class's node list for the grid. The output is always a list of
// ORIGINAL node indices, so every structural action (rename, retype, delete, insert, repeat,
// create-class) keeps addressing the real node even while the grid shows a filtered subset.
// Pure and allocation-light so it can run per keystroke on large classes.

export type FilterMode = "all" | "changed" | "pointers" | "unnamed" | "numeric";

export const FILTER_MODES: readonly { id: FilterMode; label: string }[] = [
    { id: "all", label: "All" },
    { id: "changed", label: "Changed" },
    { id: "pointers", label: "Pointers" },
    { id: "unnamed", label: "Unnamed" },
    { id: "numeric", label: "Numeric" },
];

export interface FilterInput {
    nodes: readonly Node[];
    /** Search text; empty matches everything. Matched (case-insensitive) against field name,
     *  offset hex, absolute address, displayed value, and type label. */
    query: string;
    mode: FilterMode;
    /** Class base address as bigint, or undefined when the class has no address (address search
     *  then matches nothing). */
    base?: bigint;
    /** Live snapshot for value matching / changed detection; without one, value search matches
     *  nothing and "changed" yields no rows. */
    view?: DataView;
    baseline?: Baseline;
    refs?: RefResolvers;
}

function isNumericNode(node: Node): boolean {
    const cat = NODE_TYPES[node.typeId].category;
    return cat === "int" || cat === "uint" || cat === "float";
}

function modeMatch(input: FilterInput, node: Node, offset: number): boolean {
    switch (input.mode) {
        case "all":
            return true;
        case "pointers":
            return isPointerType(node.typeId);
        case "unnamed":
            return node.name === undefined && !isFill(node.typeId);
        case "numeric":
            return isNumericNode(node);
        case "changed":
            return (
                input.view !== undefined &&
                input.baseline !== undefined &&
                changedFromBaseline(input.view, input.baseline, offset, nodeByteSize(node))
            );
    }
}

function queryMatch(input: FilterInput, node: Node, offset: number, q: string): boolean {
    if (q === "") return true;
    if (node.name && node.name.toLowerCase().includes(q)) return true;
    if (NODE_TYPES[node.typeId].label.toLowerCase().includes(q)) return true;

    // Offset: match against the padded hex ("001c") and the bare/0x forms ("1c", "0x1c").
    const offHex = offset.toString(16);
    if (offHex.includes(q) || `0x${offHex}`.includes(q) || offHex.padStart(4, "0").includes(q)) return true;

    if (input.base !== undefined) {
        const addr = (input.base + BigInt(offset)).toString(16);
        if (addr.includes(q.replace(/^0x/, ""))) return true;
    }

    if (input.view) {
        const value = decodeNode(input.view, offset, node, input.refs);
        if (value && value.toLowerCase().includes(q)) return true;
    }
    return false;
}

/** Original indices of the nodes passing the mode filter and the search query, in order. */
export function filterNodes(input: FilterInput): number[] {
    const offs = offsets(input.nodes);
    const q = input.query.trim().toLowerCase();
    const out: number[] = [];
    for (let i = 0; i < input.nodes.length; i++) {
        const node = input.nodes[i];
        if (!modeMatch(input, node, offs[i])) continue;
        if (!queryMatch(input, node, offs[i], q)) continue;
        out.push(i);
    }
    return out;
}

/** Parse a "go to offset" input: hex by default ("1c", "0x1C"), decimal with a "d" suffix or a
 *  plain integer when prefixed "+". Returns undefined on malformed input. */
export function parseGotoOffset(text: string): number | undefined {
    const t = text.trim().toLowerCase();
    if (t === "") return undefined;
    if (/^0x[0-9a-f]+$/.test(t)) return Number.parseInt(t.slice(2), 16);
    if (/^[0-9a-f]+$/.test(t)) return Number.parseInt(t, 16);
    return undefined;
}

/** Index of the node containing byte `offset` (or the nearest following node), or undefined
 *  when the offset is past the end of the class. */
export function indexAtOffset(nodes: readonly Node[], offset: number): number | undefined {
    const offs = offsets(nodes);
    for (let i = 0; i < nodes.length; i++) {
        if (offset < offs[i] + nodeByteSize(nodes[i])) return i;
    }
    return undefined;
}

/** Position of original index `origIndex` inside the filtered list, or the nearest earlier
 *  visible row (for scrolling to a filtered-out node), or 0 when nothing precedes it. */
export function nearestVisiblePosition(visible: readonly number[], origIndex: number): number {
    let best = 0;
    for (let i = 0; i < visible.length; i++) {
        if (visible[i] === origIndex) return i;
        if (visible[i] < origIndex) best = i;
        else break;
    }
    return best;
}
