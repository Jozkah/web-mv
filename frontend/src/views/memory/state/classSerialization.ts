import { createNode } from "../nodes/layout";
import {
    isRefType,
    isStringType,
    NODE_TYPES,
    type DisplayFormat,
    type Endian,
    type Node,
    type NodeTypeId,
} from "../nodes/types";

// The durable shape of the memory viewer's class definitions: what persists to localStorage,
// what undo snapshots hold, and what session export/import round-trips. Pure - no Solid, no
// storage access - so hydration, validation, and the v2 -> v3 migration are unit-testable.
//
// v2 stored { typeId, name?, length? } per node. v3 adds the optional per-node overrides
// (displayFormat / endian / refName / bitNames / locked) and per-class analysis settings; every
// addition is optional, so a v2 payload IS a valid v3 payload and migration is acceptance, not
// transformation. New typeIds only ever appear in v3 payloads.

export const MEMORY_STORAGE_VERSION = 3;
/** The previous schema version we still accept (migrated on load, saved back as v3). */
export const MEMORY_STORAGE_LEGACY_VERSION = 2;

export interface MemoryClass {
    id: string;
    name: string;
    address: string; // canonical hex, or "" until the user enters one
    nodes: Node[];
}

export interface SavedNode {
    typeId: NodeTypeId;
    name?: string;
    length?: number; // byte span of a string/ref field; absent for fixed types
    displayFormat?: DisplayFormat;
    endian?: Endian;
    refName?: string;
    bitNames?: string[];
    locked?: boolean;
}

export interface SavedClass {
    name: string;
    address: string;
    nodes: SavedNode[];
}

/** Per-class-set analysis toggles, persisted with the classes (feature 4). */
export interface SavedAnalysisSettings {
    autoGuess?: boolean;
    autoGrow?: boolean;
}

export interface SavedState {
    classes: SavedClass[];
    activeIndex: number;
    expandedPaths?: string[];
    settings?: SavedAnalysisSettings;
}

export function serializeNode(n: Node): SavedNode {
    const s: SavedNode = { typeId: n.typeId };
    if (n.name !== undefined) s.name = n.name;
    if (n.length !== undefined) s.length = n.length;
    if (n.displayFormat !== undefined) s.displayFormat = n.displayFormat;
    if (n.endian !== undefined) s.endian = n.endian;
    if (n.refName !== undefined) s.refName = n.refName;
    if (n.bitNames !== undefined) s.bitNames = [...n.bitNames];
    if (n.locked) s.locked = true;
    return s;
}

const DISPLAY_FORMATS: readonly string[] = ["auto", "dec", "hex", "bin"];

/** Validate one raw saved node. Returns undefined for a structurally broken node. A refName
 *  pointing at a struct/enum that no longer exists is NOT an error here - the row renders a
 *  "missing" state instead (the captured `length` keeps the layout stable). */
export function sanitizeSavedNode(raw: unknown): SavedNode | undefined {
    const n = raw as SavedNode | null;
    if (!n || !(n.typeId in NODE_TYPES)) return undefined;
    // Variable-size types must carry a numeric byte span or the whole layout would shift.
    if ((isStringType(n.typeId) || isRefType(n.typeId)) && typeof n.length !== "number") return undefined;
    if (isRefType(n.typeId) && typeof n.refName !== "string") return undefined;

    const out: SavedNode = { typeId: n.typeId };
    if (typeof n.name === "string") out.name = n.name;
    if (typeof n.length === "number" && (isStringType(n.typeId) || isRefType(n.typeId))) out.length = n.length;
    if (typeof n.displayFormat === "string" && DISPLAY_FORMATS.includes(n.displayFormat)) {
        out.displayFormat = n.displayFormat;
    }
    if (n.endian === "be" || n.endian === "le") out.endian = n.endian;
    if (typeof n.refName === "string") out.refName = n.refName;
    if (Array.isArray(n.bitNames)) {
        out.bitNames = n.bitNames.map((b) => (typeof b === "string" ? b : ""));
    }
    if (n.locked === true) out.locked = true;
    return out;
}

/** Validate one raw saved class; undefined when the class (or any node in it) is broken. */
export function sanitizeSavedClass(raw: unknown): SavedClass | undefined {
    const c = raw as SavedClass | null;
    if (!c || typeof c.name !== "string" || typeof c.address !== "string" || !Array.isArray(c.nodes)) {
        return undefined;
    }
    const nodes: SavedNode[] = [];
    for (const n of c.nodes) {
        const clean = sanitizeSavedNode(n);
        if (!clean) return undefined;
        nodes.push(clean);
    }
    return { name: c.name, address: c.address, nodes };
}

/**
 * Validate a whole saved payload (v2 or v3 - the v3 fields are all optional). All-or-nothing
 * over the classes: any structurally bad class discards the payload rather than hydrating a
 * partial, broken set (matching the original loader's behavior).
 */
export function sanitizeSavedState(raw: unknown): SavedState | undefined {
    const saved = raw as SavedState | null;
    if (!saved || !Array.isArray(saved.classes) || saved.classes.length === 0) return undefined;

    const classes: SavedClass[] = [];
    for (const c of saved.classes) {
        const clean = sanitizeSavedClass(c);
        if (!clean) return undefined;
        classes.push(clean);
    }

    const activeIndex =
        Number.isInteger(saved.activeIndex) && saved.activeIndex >= 0 && saved.activeIndex < classes.length
            ? saved.activeIndex
            : 0;
    const expandedPaths = Array.isArray(saved.expandedPaths)
        ? saved.expandedPaths.filter((p): p is string => typeof p === "string")
        : [];

    const out: SavedState = { classes, activeIndex, expandedPaths };
    const s = saved.settings;
    if (s && typeof s === "object") {
        out.settings = {};
        if (typeof s.autoGuess === "boolean") out.settings.autoGuess = s.autoGuess;
        if (typeof s.autoGrow === "boolean") out.settings.autoGrow = s.autoGrow;
    }
    return out;
}

/**
 * Accept a raw storage envelope under the current OR the legacy schema version. v2 payloads
 * carry no v3 fields, so acceptance through the same sanitizer IS the migration; the next
 * save writes them back as v3.
 */
export function migrateSavedPayload(
    envelope: { v: number; data: unknown } | undefined,
): SavedState | undefined {
    if (!envelope) return undefined;
    if (envelope.v !== MEMORY_STORAGE_VERSION && envelope.v !== MEMORY_STORAGE_LEGACY_VERSION) {
        return undefined;
    }
    return sanitizeSavedState(envelope.data);
}

/** Materialize a saved class's nodes with fresh runtime ids. */
export function buildNodes(saved: SavedClass): Node[] {
    return saved.nodes.map((n) =>
        createNode(n.typeId, n.name, n.length, {
            displayFormat: n.displayFormat,
            endian: n.endian,
            refName: n.refName,
            bitNames: n.bitNames,
            locked: n.locked,
        }),
    );
}
