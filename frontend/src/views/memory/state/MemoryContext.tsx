import { createContext, createSignal, useContext, type JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { fieldLength, fieldType, fieldSize, isFill, isStringType, NODE_TYPES, nodeByteSize, type GuessField, type Node, type NodeTypeId } from "../nodes/types";
import { addBytes, clearType, createNode, deleteNode, deleteNodes, insertBytes, offsets, padding, renameNode, repeatNodes, setNodeType, setNodeTypeForIds, topIndexOf, totalSize } from "../nodes/layout";
import { parseHex, toHex } from "../../../state/address";
import { load, persistKeyed } from "../../../state/persist";
import { useApp } from "../../../app/AppContext";

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
    // Which pointer nodes are expanded inline (their target struct rendered beneath them). Keyed
    // by a path string - a top-level pointer uses its node id; a nested one uses "<parentPath>/
    // <childOffset>" - so recursion stays unambiguous and the set survives a reload.
    expandedPaths: string[];
}

// Ceiling for auto-struct inline growth, so a class that always reads live data at its tail
// can't grow without bound. One chunk of padding is appended each time data reaches the end.
const AUTO_GROW_MAX = 0x1000;
const AUTO_GROW_CHUNK = 0x40;

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
// Class definitions are namespaced per attached target (see workspaceKey.ts): the base key is
// suffixed with the current workspace key so switching targets loads that target's own classes.
const STORAGE_KEY = "ax.memory";
// v2 added expandedPaths (inline pointer-expansion state).
const STORAGE_VERSION = 2;

const storageKeyFor = (wsKey: string) => `${STORAGE_KEY}:${wsKey}`;

// How many mutations the undo stack retains. Bounded so a long session can't grow it without limit.
const MAX_UNDO = 60;

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
    expandedPaths?: string[];
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
        expandedPaths: store.expandedPaths,
    };
}

function makeDefault(): MemoryStore {
    const first = newClass();
    return { classes: [first], activeId: first.id, selectedNodeIds: [], expandedPaths: [] };
}

// Rebuild the store from a saved payload (from localStorage OR an undo snapshot), or undefined to
// fall back to a fresh default. Any structurally bad class (or an unknown node type from a drifted
// schema) discards the whole payload rather than hydrating a partial, broken set of classes.
function buildFromSaved(payload: unknown): MemoryStore | undefined {
    const saved = payload as SavedState | null;
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
    const expandedPaths = Array.isArray(saved.expandedPaths)
        ? saved.expandedPaths.filter((p): p is string => typeof p === "string")
        : [];
    return { classes, activeId: classes[activeIndex].id, selectedNodeIds: [], expandedPaths };
}

function createMemoryState() {
    const app = useApp();

    const initial: MemoryStore =
        buildFromSaved(load<SavedState>(storageKeyFor(app.workspaceKey()), STORAGE_VERSION)) ?? makeDefault();
    const [store, setStore] = createStore<MemoryStore>(initial);

    // Swap the whole class set (target switch, or an undo/redo restore) in one produce; selection
    // is transient UI and always resets.
    const replaceStore = (next: MemoryStore) => {
        setStore(
            produce((s) => {
                s.classes = next.classes;
                s.activeId = next.activeId;
                s.selectedNodeIds = [];
            }),
        );
    };

    // Undo/redo. Snapshots are the same serialized shape we persist, so any durable change - rename,
    // retype, insert/delete, add/remove class - is captured generically. Selection changes are not.
    const undoStack: SavedState[] = [];
    const redoStack: SavedState[] = [];
    const [undoDepth, setUndoDepth] = createSignal(0);
    const [redoDepth, setRedoDepth] = createSignal(0);
    const syncDepths = () => {
        setUndoDepth(undoStack.length);
        setRedoDepth(redoStack.length);
    };
    const clearHistory = () => {
        undoStack.length = 0;
        redoStack.length = 0;
        syncDepths();
    };
    // Capture the pre-change state. Call at the top of every mutating action; a new action
    // invalidates the redo branch.
    const pushUndo = () => {
        undoStack.push(serialize(store));
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        syncDepths();
    };
    const restore = (saved: SavedState) => replaceStore(buildFromSaved(saved) ?? makeDefault());

    // Namespaced persistence: follows the attached target. On a target switch, reload that target's
    // classes and drop the (now-foreign) undo history.
    persistKeyed(
        () => storageKeyFor(app.workspaceKey()),
        STORAGE_VERSION,
        () => serialize(store),
        (loaded) => {
            replaceStore(buildFromSaved(loaded) ?? makeDefault());
            clearHistory();
        },
    );

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
        get expandedPaths() {
            return store.expandedPaths;
        },
        activeClass,

        // Serialize all class definitions to JSON (the same shape as the persisted state) for the
        // struct round-trip and session save. Import appends any structurally valid classes and
        // returns how many were added; a bad node type or malformed string field skips that class.
        exportJson(): string {
            return JSON.stringify(serialize(store), null, 2);
        },
        importJson(text: string): number {
            const data = JSON.parse(text) as SavedState;
            if (!data || !Array.isArray(data.classes)) throw new Error("expected an object with a classes array");
            let added = 0;
            setStore(
                produce((s) => {
                    for (const c of data.classes) {
                        if (!c || typeof c.name !== "string" || typeof c.address !== "string" || !Array.isArray(c.nodes)) continue;
                        const nodes: Node[] = [];
                        let ok = true;
                        for (const n of c.nodes) {
                            if (!n || !(n.typeId in NODE_TYPES)) { ok = false; break; }
                            if (isStringType(n.typeId) && typeof n.length !== "number") { ok = false; break; }
                            nodes.push(createNode(n.typeId, typeof n.name === "string" ? n.name : undefined, isStringType(n.typeId) ? n.length : undefined));
                        }
                        if (!ok) continue;
                        classSeq++;
                        s.classes.push({ id: `c${classSeq}`, name: c.name, address: c.address, nodes });
                        added++;
                    }
                    if (added > 0 && s.activeId === null) s.activeId = s.classes[0]?.id ?? null;
                }),
            );
            return added;
        },

        // Push the new class AND activate it in a SINGLE store update. Splitting these across
        // separate setStore calls is a trap: the push makes <For> build the new row's effects,
        // which subscribe to activeId while it still holds the OLD value, and the later separate
        // write doesn't re-fire them - the sidebar/grid stay on the previous class. One produce
        // means the new row is created with activeId already correct and the old row updates too.
        addClass() {
            pushUndo();
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
            pushUndo();
            const c = newClass(address, name);
            setStore(produce((s) => {
                s.classes.push(c);
                s.activeId = c.id;
                s.selectedNodeIds = [];
            }));
            try {
                app.history.addMemory({ classId: c.id, className: c.name, address: c.address });
            } catch {}
            return c.id;
        },
        removeClass(id: string) {
            pushUndo();
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
            try {
                const target = store.classes.find((c) => c.id === id);
                if (target) {
                    app.history.addMemory({ classId: target.id, className: target.name, address: target.address });
                }
            } catch {}
        },
        renameClass(id: string, name: string) {
            const trimmed = name.trim();
            if (trimmed) {
                pushUndo();
                setStore("classes", (c) => c.id === id, "name", trimmed);
            }
        },
        setAddress(address: string) {
            const id = store.activeId;
            if (id !== null) {
                pushUndo();
                setStore("classes", (c) => c.id === id, "address", address);
            }
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

        // Inline pointer expansion. A path uniquely names an expandable pointer at any depth (see
        // expandedPaths); toggling adds/removes it, isExpanded drives the disclosure + child render.
        isExpanded(path: string): boolean {
            return store.expandedPaths.includes(path);
        },
        toggleExpanded(path: string) {
            setStore("expandedPaths", (paths) =>
                paths.includes(path) ? paths.filter((p) => p !== path) : [...paths, path],
            );
        },

        // Auto-struct inline growth: when live data has reached the class's tail (its last node is
        // a typed field, not untyped padding), append a chunk of padding so the struct can keep
        // growing as more fields are discovered - the in-place analogue of following a pointer into
        // a fresh class. Capped so a class over live data can't grow without bound. Returns true
        // when it grew, so the caller can throttle.
        autoGrowActiveClass(): boolean {
            const cls = activeClass();
            if (!cls || cls.nodes.length === 0) return false;
            const last = cls.nodes[cls.nodes.length - 1];
            if (isFill(last.typeId)) return false; // tail is still padding - room remains
            if (totalSize(cls.nodes) >= AUTO_GROW_MAX) return false;
            updateNodes((nodes) => addBytes(nodes, AUTO_GROW_CHUNK));
            return true;
        },
        setNodeType(index: number, typeId: NodeTypeId) {
            pushUndo();
            updateNodes((nodes) => setNodeType(nodes, index, typeId));
        },
        clearNodeType(index: number) {
            pushUndo();
            updateNodes((nodes) => clearType(nodes, index));
        },
        // Apply auto-guess results: replace each planned tile with its guessed field(s). A guess
        // is only honored when the tile is STILL an untyped fill of the planned byte span - a
        // guess can land a tick after the user has typed or resized that node by hand, and their
        // choice must win. Each replacement spans the same byte count, so later offsets never move.
        applyGuesses(plan: Map<string, GuessField[]>) {
            if (plan.size === 0) return;
            pushUndo();
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
            pushUndo();
            updateNodes((nodes) => renameNode(nodes, index, name));
        },
        insertBytes(index: number, bytes: number, below = false) {
            pushUndo();
            updateNodes((nodes) => insertBytes(nodes, index, bytes, below));
        },
        addBytes(bytes: number) {
            pushUndo();
            updateNodes((nodes) => addBytes(nodes, bytes));
        },
        deleteNode(index: number) {
            pushUndo();
            updateNodes((nodes) => deleteNode(nodes, index));
        },

        // Multi-select menu actions, applied to the whole selection in the active class.

        // Retype every selected node.
        setSelectedType(typeId: NodeTypeId) {
            const ids = store.selectedNodeIds;
            if (ids.length === 0) return;
            pushUndo();
            updateNodes((nodes) => setNodeTypeForIds(nodes, ids, typeId));
        },
        // Repeat the selected nodes `times` more times (array-of-struct). No-op if nothing selected.
        repeatSelection(times: number) {
            const ids = new Set(store.selectedNodeIds);
            if (ids.size === 0) return;
            updateNodes((nodes) => repeatNodes(nodes, ids, times));
        },
        // Insert padding above the topmost selected node (ReClass "Insert"). No-op if nothing
        // selected; addBytes covers the append case.
        insertBytesAboveSelection(bytes: number) {
            const ids = new Set(store.selectedNodeIds);
            if (ids.size === 0) return;
            pushUndo();
            updateNodes((nodes) => {
                const top = topIndexOf(nodes, ids);
                return top < 0 ? nodes : insertBytes(nodes, top, bytes, false);
            });
        },
        // Delete every selected node and clear the selection.
        deleteSelected() {
            const ids = new Set(store.selectedNodeIds);
            if (ids.size === 0) return;
            pushUndo();
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
            pushUndo();
            const address = cls.address ? toHex(parseHex(cls.address) + BigInt(topOff)) : "";
            classSeq++;
            const created: MemoryClass = { id: `c${classSeq}`, name: `Class${classSeq}`, address, nodes: picked };
            setStore(produce((s) => {
                s.classes.push(created);
                s.activeId = created.id;
                s.selectedNodeIds = [];
            }));
        },

        // General undo/redo over durable class state (renames, retypes, insert/delete, add/remove
        // class). Selection is transient and never enters the stack. Bounded at MAX_UNDO.
        undo() {
            if (undoStack.length === 0) return;
            redoStack.push(serialize(store));
            restore(undoStack.pop()!);
            syncDepths();
        },
        redo() {
            if (redoStack.length === 0) return;
            undoStack.push(serialize(store));
            restore(redoStack.pop()!);
            syncDepths();
        },
        get canUndo() {
            return undoDepth() > 0;
        },
        get canRedo() {
            return redoDepth() > 0;
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
