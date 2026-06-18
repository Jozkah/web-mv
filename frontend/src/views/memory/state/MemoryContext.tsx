import { createContext, useContext, type JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { fieldLength, fieldType, fieldSize, isFill, isStringType, NODE_TYPES, nodeByteSize, type GuessField, type Node, type NodeTypeId } from "../nodes/types";
import { addBytes, clearType, createNode, deleteNode, deleteNodes, insertBytes, offsets, padding, renameNode, setNodeType, setNodeTypeForIds, topIndexOf } from "../nodes/layout";
import { parseHex, toHex } from "../../../state/address";
import { load, persist } from "../../../state/persist";

// Durable state for the memory viewer: the class definitions, which one is active, and the
// selected node. This is the structure the user builds; it outlives tab switches. The live
// byte snapshot is not here - that's transient, owned by the view's poll (useMemorySnapshot).

export interface MemoryClass {
    id: string;
    name: string;
    address: string; // canonical hex, or "" until the user enters one
    nodes: Node[];
}

interface MemoryStore {
    classes: MemoryClass[];
    activeId: string | null;
    // The selected node ids, in no particular order. A plain click selects one; Ctrl+click
    // toggles. Menu actions apply to the whole set. Cleared on any class switch.
    selectedNodeIds: string[];
}

let classSeq = 0;

// A fresh class starts as a block of hex padding - a blank canvas to retype as fields are
// discovered. 0x100 bytes is enough to be useful without a wall of rows. An address (and
// name) can be seeded - e.g. when a scan hit spawns a class already pointed at the hit.
function newClass(address = "", name?: string): MemoryClass {
    classSeq++;
    return { id: `c${classSeq}`, name: name ?? `Class${classSeq}`, address, nodes: padding(0x100) };
}

// localStorage persistence of the class definitions. Only the durable shape is stored - names,
// addresses, and each node's type+name; node ids and the live byte snapshot are not. On load the
// ids are re-minted through createNode/newClass so the runtime seq counters can never collide with
// a restored id, and the selection (transient UI) resets. activeIndex (not an id) carries which
// class was active across the re-mint.
const STORAGE_KEY = "ax.memory";
const STORAGE_VERSION = 1;

interface SavedNode {
    typeId: NodeTypeId;
    name?: string;
    length?: number; // byte span of a string field; absent for fixed types
}
interface SavedClass {
    name: string;
    address: string;
    nodes: SavedNode[];
}
interface SavedState {
    classes: SavedClass[];
    activeIndex: number;
}

function serializeNode(n: Node): SavedNode {
    const s: SavedNode = { typeId: n.typeId };
    if (n.name !== undefined) s.name = n.name;
    if (n.length !== undefined) s.length = n.length;
    return s;
}

function serialize(store: MemoryStore): SavedState {
    return {
        classes: store.classes.map((c) => ({
            name: c.name,
            address: c.address,
            nodes: c.nodes.map(serializeNode),
        })),
        activeIndex: store.classes.findIndex((c) => c.id === store.activeId),
    };
}

// Rebuild the store from a saved payload, or undefined to fall back to a fresh default. Any
// structurally bad class (or an unknown node type from a drifted schema) discards the whole
// payload rather than hydrating a partial, broken set of classes.
function hydrate(): MemoryStore | undefined {
    const saved = load<SavedState>(STORAGE_KEY, STORAGE_VERSION);
    if (!saved || !Array.isArray(saved.classes) || saved.classes.length === 0) return undefined;

    const classes: MemoryClass[] = [];
    for (const c of saved.classes) {
        if (!c || typeof c.name !== "string" || typeof c.address !== "string" || !Array.isArray(c.nodes)) return undefined;
        const nodes: Node[] = [];
        for (const n of c.nodes) {
            if (!n || !(n.typeId in NODE_TYPES)) return undefined;
            // A string field must carry a numeric byte span; a malformed one discards the payload.
            if (isStringType(n.typeId) && typeof n.length !== "number") return undefined;
            const length = isStringType(n.typeId) ? (n.length as number) : undefined;
            nodes.push(createNode(n.typeId, typeof n.name === "string" ? n.name : undefined, length));
        }
        classSeq++;
        classes.push({ id: `c${classSeq}`, name: c.name, address: c.address, nodes });
    }

    const activeIndex =
        Number.isInteger(saved.activeIndex) && saved.activeIndex >= 0 && saved.activeIndex < classes.length
            ? saved.activeIndex
            : 0;
    return { classes, activeId: classes[activeIndex].id, selectedNodeIds: [] };
}

function createMemoryState() {
    const initial: MemoryStore = hydrate() ?? (() => {
        const first = newClass();
        return { classes: [first], activeId: first.id, selectedNodeIds: [] };
    })();
    const [store, setStore] = createStore<MemoryStore>(initial);

    persist(STORAGE_KEY, STORAGE_VERSION, () => serialize(store));

    const activeClass = (): MemoryClass | undefined =>
        store.classes.find((c) => c.id === store.activeId);

    // Apply a pure node-list transform to the active class.
    const updateNodes = (fn: (nodes: Node[]) => Node[]) => {
        const id = store.activeId;
        if (id === null) return;
        setStore(
            "classes",
            (c) => c.id === id,
            "nodes",
            (nodes) => fn(nodes),
        );
    };

    return {
        get classes() {
            return store.classes;
        },
        get activeId() {
            return store.activeId;
        },
        get selectedNodeIds() {
            return store.selectedNodeIds;
        },
        activeClass,

        // Push the new class AND activate it in a SINGLE store update. Splitting these across
        // separate setStore calls is a trap: the push makes <For> build the new row's effects,
        // which subscribe to activeId while it still holds the OLD value, and the later separate
        // write doesn't re-fire them - the sidebar/grid stay on the previous class. One produce
        // means the new row is created with activeId already correct and the old row updates too.
        addClass() {
            setStore(produce((s) => {
                const c = newClass();
                s.classes.push(c);
                s.activeId = c.id;
                s.selectedNodeIds = [];
            }));
        },
        // addClass seeded at a known address (e.g. a scan hit / followed pointer) so the viewer
        // reads there immediately. Returns the new class id.
        addClassAt(address: string, name?: string): string {
            const c = newClass(address, name);
            setStore(produce((s) => {
                s.classes.push(c);
                s.activeId = c.id;
                s.selectedNodeIds = [];
            }));
            return c.id;
        },
        removeClass(id: string) {
            setStore(produce((s) => {
                s.classes = s.classes.filter((c) => c.id !== id);
                if (s.activeId === id) {
                    s.activeId = s.classes[0]?.id ?? null;
                    s.selectedNodeIds = [];
                }
            }));
        },
        selectClass(id: string) {
            setStore(produce((s) => {
                s.activeId = id;
                s.selectedNodeIds = [];
            }));
        },
        renameClass(id: string, name: string) {
            const trimmed = name.trim();
            if (trimmed) setStore("classes", (c) => c.id === id, "name", trimmed);
        },
        setAddress(address: string) {
            const id = store.activeId;
            if (id !== null) setStore("classes", (c) => c.id === id, "address", address);
        },

        // Selection. A plain click replaces the selection with one node; Ctrl+click toggles a
        // node in or out. isSelected drives the row highlight.
        selectNode(nodeId: string) {
            setStore("selectedNodeIds", [nodeId]);
        },
        toggleNode(nodeId: string) {
            setStore("selectedNodeIds", (ids) =>
                ids.includes(nodeId) ? ids.filter((id) => id !== nodeId) : [...ids, nodeId],
            );
        },
        clearSelection() {
            setStore("selectedNodeIds", []);
        },
        isSelected(nodeId: string): boolean {
            return store.selectedNodeIds.includes(nodeId);
        },
        setNodeType(index: number, typeId: NodeTypeId) {
            updateNodes((nodes) => setNodeType(nodes, index, typeId));
        },
        clearNodeType(index: number) {
            updateNodes((nodes) => clearType(nodes, index));
        },
        // Apply auto-guess results: replace each planned tile with its guessed field(s). A guess
        // is only honored when the tile is STILL an untyped fill of the planned byte span - a
        // guess can land a tick after the user has typed or resized that node by hand, and their
        // choice must win. Each replacement spans the same byte count, so later offsets never move.
        applyGuesses(plan: Map<string, GuessField[]>) {
            if (plan.size === 0) return;
            updateNodes((nodes) =>
                nodes.flatMap((n) => {
                    const fields = plan.get(n.id);
                    if (!fields || fields.length === 0 || !isFill(n.typeId)) return [n];
                    const span = fields.reduce((sum, f) => sum + fieldSize(f), 0);
                    if (span !== nodeByteSize(n)) return [n];
                    return fields.map((f, k) => createNode(fieldType(f), k === 0 ? n.name : undefined, fieldLength(f)));
                }),
            );
        },
        renameNode(index: number, name: string) {
            updateNodes((nodes) => renameNode(nodes, index, name));
        },
        insertBytes(index: number, bytes: number, below = false) {
            updateNodes((nodes) => insertBytes(nodes, index, bytes, below));
        },
        addBytes(bytes: number) {
            updateNodes((nodes) => addBytes(nodes, bytes));
        },
        deleteNode(index: number) {
            updateNodes((nodes) => deleteNode(nodes, index));
        },

        // Multi-select menu actions, applied to the whole selection in the active class.

        // Retype every selected node.
        setSelectedType(typeId: NodeTypeId) {
            const ids = store.selectedNodeIds;
            if (ids.length === 0) return;
            updateNodes((nodes) => setNodeTypeForIds(nodes, ids, typeId));
        },
        // Insert padding above the topmost selected node (ReClass "Insert"). No-op if nothing
        // selected; addBytes covers the append case.
        insertBytesAboveSelection(bytes: number) {
            const ids = new Set(store.selectedNodeIds);
            updateNodes((nodes) => {
                const top = topIndexOf(nodes, ids);
                return top < 0 ? nodes : insertBytes(nodes, top, bytes, false);
            });
        },
        // Delete every selected node and clear the selection.
        deleteSelected() {
            const ids = new Set(store.selectedNodeIds);
            if (ids.size === 0) return;
            updateNodes((nodes) => deleteNodes(nodes, ids));
            setStore("selectedNodeIds", []);
        },
        // Build a new class from copies of the selected nodes (in offset order), seeded at the
        // address of the topmost one so it reads the same memory, then switch to it. The source
        // class is left intact (we have no class-instance node type to replace them with).
        createClassFromSelection() {
            const cls = activeClass();
            if (!cls) return;
            const ids = new Set(store.selectedNodeIds);
            if (ids.size === 0) return;
            const offs = offsets(cls.nodes);
            const picked: Node[] = [];
            let topOff = -1;
            cls.nodes.forEach((n, i) => {
                if (!ids.has(n.id)) return;
                if (topOff < 0) topOff = offs[i];
                picked.push(createNode(n.typeId, n.name, n.length));
            });
            if (picked.length === 0) return;
            const address = cls.address ? toHex(parseHex(cls.address) + BigInt(topOff)) : "";
            classSeq++;
            const created: MemoryClass = { id: `c${classSeq}`, name: `Class${classSeq}`, address, nodes: picked };
            setStore(produce((s) => {
                s.classes.push(created);
                s.activeId = created.id;
                s.selectedNodeIds = [];
            }));
        },
    };
}

export type MemoryState = ReturnType<typeof createMemoryState>;

const MemoryContext = createContext<MemoryState>();

export function MemoryProvider(props: { children: JSX.Element }) {
    const state = createMemoryState();
    return <MemoryContext.Provider value={state}>{props.children}</MemoryContext.Provider>;
}

export function useMemory(): MemoryState {
    const state = useContext(MemoryContext);
    if (!state) throw new Error("useMemory must be used within a MemoryProvider");
    return state;
}
