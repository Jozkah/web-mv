import type { DisplayFormat, Endian, Node, NodeTypeId } from "./types";
import { isRefType, isStringType, nodeByteSize, nodeSize, supportsDisplayFormat, supportsEndian } from "./types";

// Pure operations over a class's node list. Nodes tile a contiguous region with no gaps;
// every node's offset is the running sum of the sizes before it, so these helpers are the
// single source of truth for layout. Edits keep the bytes after the edit point aligned to
// the same memory offsets by consuming/releasing padding right after the changed node -
// the way a class redefinition should behave over a live object.
//
// Variable-size types (strings, struct/enum references) carry their byte span on the node
// (`length`), captured when the type is assigned. Layout math only ever reads that stored
// span - never the live dataTypes registry - so a registry edit can't silently shift every
// field after a structref; the user re-applies the type to pick up a new size.

let seq = 0;

export function createNode(typeId: NodeTypeId, name?: string, length?: number, extra?: Partial<Node>): Node {
    const node: Node = { id: `n${seq++}`, typeId };
    if (name !== undefined) node.name = name;
    if (length !== undefined) node.length = length;
    if (extra) {
        if (extra.displayFormat !== undefined) node.displayFormat = extra.displayFormat;
        if (extra.endian !== undefined) node.endian = extra.endian;
        if (extra.refName !== undefined) node.refName = extra.refName;
        if (extra.bitNames !== undefined) node.bitNames = extra.bitNames;
        if (extra.locked !== undefined) node.locked = extra.locked;
    }
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

/** Options for retyping a node into a variable-size or registry-referencing type. */
export interface SetTypeOptions {
    /** Byte span for a structref/enumref (captured from the registry at pick time). */
    length?: number;
    /** Struct/enum name for a structref/enumref node. */
    refName?: string;
}

/** Retype a node, consuming/releasing padding after it so later offsets don't shift. A string
 *  wraps the node's whole byte span (wstring rounds down to an even span); a registry ref takes
 *  its span from `opts.length`; a fixed type drops any stale `length`. Type-specific overrides
 *  (display format, endian, bit names) reset on retype; the name and lock survive. */
export function setNodeType(nodes: readonly Node[], index: number, typeId: NodeTypeId, opts?: SetTypeOptions): Node[] {
    const out = nodes.slice();
    const old = out[index];
    const oldSize = nodeByteSize(old);

    const node: Node = { id: old.id, typeId };
    if (old.name !== undefined) node.name = old.name;
    if (old.locked) node.locked = true;
    let newSize: number;
    if (isStringType(typeId)) {
        newSize = typeId === "wstring" ? oldSize - (oldSize % 2) : oldSize;
        node.length = newSize;
    } else if (isRefType(typeId)) {
        newSize = Math.max(1, opts?.length ?? nodeSize(typeId) ?? 1);
        node.length = newSize;
        if (opts?.refName !== undefined) node.refName = opts.refName;
    } else {
        newSize = nodeSize(typeId);
    }
    out[index] = node;

    const delta = newSize - oldSize;
    if (delta > 0) return consume(out, index, delta);
    if (delta < 0) out.splice(index + 1, 0, ...padding(-delta));
    return out;
}

/** Resize a variable-length node (string capacity or ref span) in place, consuming/releasing
 *  padding after it so later offsets don't shift. No-op for fixed-size types. */
export function setNodeLength(nodes: readonly Node[], index: number, length: number): Node[] {
    const old = nodes[index];
    if (!isStringType(old.typeId) && !isRefType(old.typeId)) return nodes.slice();
    const clamped = Math.max(old.typeId === "wstring" ? 2 : 1, Math.floor(length));
    const newSize = old.typeId === "wstring" ? clamped - (clamped % 2) : clamped;
    const oldSize = nodeByteSize(old);
    const out = nodes.slice();
    out[index] = { ...old, length: newSize };

    const delta = newSize - oldSize;
    if (delta > 0) return consume(out, index, delta);
    if (delta < 0) out.splice(index + 1, 0, ...padding(-delta));
    return out;
}

/** Patch per-node metadata that never changes the layout (display format, endianness, bit
 *  names, lock). Unsupported overrides for the node's type are dropped rather than stored. */
export function setNodeMeta(
    nodes: readonly Node[],
    index: number,
    patch: { displayFormat?: DisplayFormat; endian?: Endian; bitNames?: string[]; locked?: boolean },
): Node[] {
    const out = nodes.slice();
    const node = { ...out[index] };
    if (patch.displayFormat !== undefined && supportsDisplayFormat(node.typeId)) {
        if (patch.displayFormat === "auto") delete node.displayFormat;
        else node.displayFormat = patch.displayFormat;
    }
    if (patch.endian !== undefined && supportsEndian(node.typeId)) {
        if (patch.endian === "le") delete node.endian;
        else node.endian = patch.endian;
    }
    if (patch.bitNames !== undefined) {
        if (patch.bitNames.length === 0) delete node.bitNames;
        else node.bitNames = patch.bitNames;
    }
    if (patch.locked !== undefined) {
        if (patch.locked) node.locked = true;
        else delete node.locked;
    }
    out[index] = node;
    return out;
}

export function renameNode(nodes: readonly Node[], index: number, name: string): Node[] {
    const out = nodes.slice();
    const trimmed = name.trim();
    // Rebuild without the name (preserving everything else) so clearing the name doesn't also
    // strip other fields.
    const base = { ...out[index] };
    delete base.name;
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
export function setNodeTypeForIds(
    nodes: readonly Node[],
    ids: Iterable<string>,
    typeId: NodeTypeId,
    opts?: SetTypeOptions,
): Node[] {
    let out = nodes.slice();
    for (const id of ids) {
        const i = out.findIndex((n) => n.id === id);
        if (i >= 0) out = setNodeType(out, i, typeId, opts);
    }
    return out;
}

/** Remove every node whose id is in `ids`; the rest shift up and the class shrinks. */
export function deleteNodes(nodes: readonly Node[], ids: Set<string>): Node[] {
    return nodes.filter((n) => !ids.has(n.id));
}

/** Repeat the selected nodes `times` more times, appending fresh copies right after the last
 *  selected node - the "array of struct" convenience: select a struct's fields, repeat to N. */
export function repeatNodes(nodes: readonly Node[], ids: Set<string>, times: number): Node[] {
    if (times < 1) return nodes.slice();
    const selected = nodes.filter((n) => ids.has(n.id));
    if (selected.length === 0) return nodes.slice();
    const lastIdx = nodes.findIndex((n) => n.id === selected[selected.length - 1].id);
    const copies: Node[] = [];
    for (let t = 0; t < times; t++) {
        for (const n of selected) copies.push(copyNode(n));
    }
    const out = nodes.slice();
    out.splice(lastIdx + 1, 0, ...copies);
    return out;
}

/** A fresh node (new id) carrying all of `n`'s durable shape - type, name, span, overrides. */
export function copyNode(n: Node): Node {
    return createNode(n.typeId, n.name, n.length, {
        displayFormat: n.displayFormat,
        endian: n.endian,
        refName: n.refName,
        bitNames: n.bitNames ? [...n.bitNames] : undefined,
        locked: n.locked,
    });
}

/** Index of the topmost (lowest-offset) node in `ids`, or -1 if none are present. */
export function topIndexOf(nodes: readonly Node[], ids: Set<string>): number {
    for (let i = 0; i < nodes.length; i++) if (ids.has(nodes[i].id)) return i;
    return -1;
}
