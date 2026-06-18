import type { Node, NodeTypeId } from "./types";
import { isStringType, nodeByteSize, nodeSize } from "./types";

// Pure operations over a class's node list. Nodes tile a contiguous region with no gaps;
// every node's offset is the running sum of the sizes before it, so these helpers are the
// single source of truth for layout. Edits keep the bytes after the edit point aligned to
// the same memory offsets by consuming/releasing padding right after the changed node -
// the way a class redefinition should behave over a live object.

let seq = 0;

export function createNode(typeId: NodeTypeId, name?: string, length?: number): Node {
    const node: Node = { id: `n${seq++}`, typeId };
    if (name !== undefined) node.name = name;
    if (length !== undefined) node.length = length;
    return node;
}

/** Byte offset of each node, parallel to the input array. */
export function offsets(nodes: readonly Node[]): number[] {
    const out: number[] = new Array(nodes.length);
    let off = 0;
    for (let i = 0; i < nodes.length; i++) {
        out[i] = off;
        off += nodeByteSize(nodes[i]);
    }
    return out;
}

/** Total byte span of the class - the amount we read each poll. */
export function totalSize(nodes: readonly Node[]): number {
    let size = 0;
    for (const n of nodes) size += nodeByteSize(n);
    return size;
}

/** Greedily fill `bytes` with untyped tiles, 8 bytes per tile by default (fill8/4/2/1). */
export function padding(bytes: number): Node[] {
    const out: Node[] = [];
    let n = bytes;
    while (n >= 8) {
        out.push(createNode("fill8"));
        n -= 8;
    }
    if (n >= 4) {
        out.push(createNode("fill4"));
        n -= 4;
    }
    if (n >= 2) {
        out.push(createNode("fill2"));
        n -= 2;
    }
    if (n >= 1) out.push(createNode("fill1"));
    return out;
}

// Remove `bytes` worth of nodes immediately after `index`, splitting a straddled node into
// untyped padding for its remainder. Used when a node grows so the tail keeps its offsets.
function consume(nodes: Node[], index: number, bytes: number): Node[] {
    const out = nodes.slice();
    let need = bytes;
    let i = index + 1;
    while (need > 0 && i < out.length) {
        const size = nodeByteSize(out[i]);
        if (size <= need) {
            out.splice(i, 1);
            need -= size;
        } else {
            out.splice(i, 1, ...padding(size - need));
            need = 0;
        }
    }
    return out;
}

/** Retype a node, consuming/releasing padding after it so later offsets don't shift. A string
 *  wraps the node's whole byte span (wstring rounds down to an even span); a fixed type drops any
 *  stale `length`. */
export function setNodeType(nodes: readonly Node[], index: number, typeId: NodeTypeId): Node[] {
    const out = nodes.slice();
    const old = out[index];
    const oldSize = nodeByteSize(old);

    const node: Node = { id: old.id, typeId };
    if (old.name !== undefined) node.name = old.name;
    let newSize: number;
    if (isStringType(typeId)) {
        newSize = typeId === "wstring" ? oldSize - (oldSize % 2) : oldSize;
        node.length = newSize;
    } else {
        newSize = nodeSize(typeId);
    }
    out[index] = node;

    const delta = newSize - oldSize;
    if (delta > 0) return consume(out, index, delta);
    if (delta < 0) out.splice(index + 1, 0, ...padding(-delta));
    return out;
}

export function renameNode(nodes: readonly Node[], index: number, name: string): Node[] {
    const out = nodes.slice();
    const trimmed = name.trim();
    // Rebuild from the bare node (preserving a string's length) so clearing the name doesn't also
    // strip other fields.
    const base: Node = { id: out[index].id, typeId: out[index].typeId };
    if (out[index].length !== undefined) base.length = out[index].length;
    out[index] = trimmed ? { ...base, name: trimmed } : base;
    return out;
}

/** Revert a node to untyped bytes of the same size, so later offsets don't shift. */
export function clearType(nodes: readonly Node[], index: number): Node[] {
    const out = nodes.slice();
    out.splice(index, 1, ...padding(nodeByteSize(out[index])));
    return out;
}

/** Insert `bytes` of untyped padding above (default) or below `index` - ReClass "Insert". */
export function insertBytes(nodes: readonly Node[], index: number, bytes: number, below = false): Node[] {
    const out = nodes.slice();
    out.splice(below ? index + 1 : index, 0, ...padding(bytes));
    return out;
}

/** Append `bytes` of untyped padding to the end of the class - ReClass "Add Bytes". */
export function addBytes(nodes: readonly Node[], bytes: number): Node[] {
    return [...nodes, ...padding(bytes)];
}

/** Remove a node entirely; everything after shifts up and the class shrinks. */
export function deleteNode(nodes: readonly Node[], index: number): Node[] {
    const out = nodes.slice();
    out.splice(index, 1);
    return out;
}

// Multi-select variants - keyed by node id, not index, so they stay correct as earlier edits
// shift later positions. Each reuses the single-node helper above.

/** Retype every node whose id is in `ids`, re-finding each index as prior retypes resize the
 *  list (consume/release padding). Ids not present are skipped. */
export function setNodeTypeForIds(nodes: readonly Node[], ids: Iterable<string>, typeId: NodeTypeId): Node[] {
    let out = nodes.slice();
    for (const id of ids) {
        const i = out.findIndex((n) => n.id === id);
        if (i >= 0) out = setNodeType(out, i, typeId);
    }
    return out;
}

/** Remove every node whose id is in `ids`; the rest shift up and the class shrinks. */
export function deleteNodes(nodes: readonly Node[], ids: Set<string>): Node[] {
    return nodes.filter((n) => !ids.has(n.id));
}

/** Index of the topmost (lowest-offset) node in `ids`, or -1 if none are present. */
export function topIndexOf(nodes: readonly Node[], ids: Set<string>): number {
    for (let i = 0; i < nodes.length; i++) if (ids.has(nodes[i].id)) return i;
    return -1;
}
