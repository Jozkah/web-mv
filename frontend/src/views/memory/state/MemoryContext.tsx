import { createContext, createSignal, useContext, type JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { fieldLength, fieldSize, fieldType, isFill, nodeByteSize, type DisplayFormat, type Endian, type GuessField, type Node, type NodeTypeId } from "../nodes/types";
import { addBytes, clearType, copyNode, createNode, deleteNode, deleteNodes, insertBytes, offsets, padding, renameNode, repeatNodes, setNodeLength, setNodeMeta, setNodeType, setNodeTypeForIds, topIndexOf, totalSize, type SetTypeOptions } from "../nodes/layout";
import { parseHex, toHex } from "../../../state/address";
import { load, loadRaw, persistKeyed } from "../../../state/persist";
import { useApp } from "../../../app/AppContext";
import {
    buildNodes,
    MEMORY_STORAGE_VERSION,
    migrateSavedPayload,
    sanitizeSavedClass,
    sanitizeSavedState,
    serializeNode,
    type MemoryClass,
    type SavedState,
} from "./classSerialization";

// Durable state for the memory viewer: the class definitions, which one is active, and the
// selected node. This is the structure the user builds; it outlives tab switches. The live
// byte snapshot is not here - that's transient, owned by the view's poll (useMemorySnapshot).

export type { MemoryClass } from "./classSerialization";

interface MemoryStore {
    classes: MemoryClass[];
    activeId: string | null;
    // The selected node ids, in selection order. A plain click selects one; Ctrl+click toggles;
    // Shift+click / Shift+arrows extend a range. Menu actions apply to the whole set. Cleared
    // on any class switch.
    selectedNodeIds: string[];
    // Which pointer nodes are expanded inline (their target struct rendered beneath them). Keyed
    // by a path string - a top-level pointer uses its node id; a nested one uses "<parentPath>/
    // <childOffset>" - so recursion stays unambiguous and the set survives a reload.
    expandedPaths: string[];
    // Analysis toggles (feature: controlled automatic analysis), persisted with the classes.
    autoGuess: boolean;
    autoGrow: boolean;
}

// Ceiling for auto-struct inline growth, so a class that always reads live data at its tail
// can't grow without bound. One chunk of padding is appended each time data reaches the end.
export const AUTO_GROW_MAX = 0x1000;
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
// addresses, and each node's type+name+overrides; node ids and the live byte snapshot are not.
// On load the ids are re-minted through createNode/newClass so the runtime seq counters can never
// collide with a restored id, and the selection (transient UI) resets. activeIndex (not an id)
// carries which class was active across the re-mint.
// Class definitions are namespaced per attached target (see workspaceKey.ts): the base key is
// suffixed with the current workspace key so switching targets loads that target's own classes.
// Schema/versioning/migration live in classSerialization.ts (v2 payloads are accepted on load
// and re-saved as v3).
const STORAGE_KEY = "ax.memory";

const storageKeyFor = (wsKey: string) => `${STORAGE_KEY}:${wsKey}`;

// How many mutations the undo stack retains. Bounded so a long session can't grow it without limit.
const MAX_UNDO = 60;

function serialize(store: MemoryStore): SavedState {
    return {
        classes: store.classes.map((c) => ({
            name: c.name,
            address: c.address,
            nodes: c.nodes.map(serializeNode),
        })),
        activeIndex: store.classes.findIndex((c) => c.id === store.activeId),
        expandedPaths: store.expandedPaths,
        settings: { autoGuess: store.autoGuess, autoGrow: store.autoGrow },
    };
}

function makeDefault(): MemoryStore {
    const first = newClass();
    return {
        classes: [first],
        activeId: first.id,
        selectedNodeIds: [],
        expandedPaths: [],
        autoGuess: true,
        autoGrow: true,
    };
}

// Rebuild the store from a validated payload (from localStorage OR an undo snapshot), or
// undefined to fall back to a fresh default. Validation is all-or-nothing (see
// sanitizeSavedState): a structurally bad class discards the whole payload rather than
// hydrating a partial, broken set of classes.
function buildFromSaved(payload: unknown): MemoryStore | undefined {
    const saved = sanitizeSavedState(payload);
    if (!saved) return undefined;

    const classes: MemoryClass[] = saved.classes.map((c) => {
        classSeq++;
        return { id: `c${classSeq}`, name: c.name, address: c.address, nodes: buildNodes(c) };
    });

    return {
        classes,
        activeId: classes[saved.activeIndex].id,
        selectedNodeIds: [],
        expandedPaths: saved.expandedPaths ?? [],
        autoGuess: saved.settings?.autoGuess ?? true,
        autoGrow: saved.settings?.autoGrow ?? true,
    };
}

/** Load a workspace's saved classes, accepting the current schema or migrating the legacy one. */
function loadForKey(key: string): MemoryStore | undefined {
    const current = load<SavedState>(key, MEMORY_STORAGE_VERSION);
    if (current) return buildFromSaved(current);
    const migrated = migrateSavedPayload(loadRaw(key));
    return migrated ? buildFromSaved(migrated) : undefined;
}

function createMemoryState() {
    const app = useApp();

    const initial: MemoryStore = loadForKey(storageKeyFor(app.workspaceKey())) ?? makeDefault();
    const [store, setStore] = createStore<MemoryStore>(initial);

    // Swap the whole class set (target switch, or an undo/redo restore) in one produce; selection
    // is transient UI and always resets.
    const replaceStore = (next: MemoryStore) => {
        setStore(
            produce((s) => {
                s.classes = next.classes;
                s.activeId = next.activeId;
                s.selectedNodeIds = [];
                s.autoGuess = next.autoGuess;
                s.autoGrow = next.autoGrow;
            }),
        );
    };

    // Undo/redo. Snapshots are the same serialized shape we persist, so any durable change - rename,
    // retype, insert/delete, add/remove class - is captured generically. Selection changes are not,
    // and neither are live process-memory writes (they alter the target, not the layout).
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
    // classes (migrating a legacy payload if that's what's stored) and drop the (now-foreign) undo
    // history.
    persistKeyed(
        () => storageKeyFor(app.workspaceKey()),
        MEMORY_STORAGE_VERSION,
        () => serialize(store),
        (loaded, key) => {
            const next = (loaded ? buildFromSaved(loaded) : undefined) ?? loadForKey(key) ?? makeDefault();
            replaceStore(next);
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

        // Analysis toggles (persisted with the class/session state; see MemoryView for how they
        // gate automatic guessing/growth).
        get autoGuess() {
            return store.autoGuess;
        },
        get autoGrow() {
            return store.autoGrow;
        },
        setAutoGuess(on: boolean) {
            setStore("autoGuess", on);
        },
        setAutoGrow(on: boolean) {
            setStore("autoGrow", on);
        },

        // Serialize all class definitions to JSON (the same shape as the persisted state) for the
        // struct round-trip and session save. Import appends any structurally valid classes and
        // returns how many were added; a bad node type or malformed string/ref field skips that
        // class (references to structs/enums that don't exist locally are kept - they render as
        // "missing" rather than being dropped).
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
                        const clean = sanitizeSavedClass(c);
                        if (!clean) continue;
                        classSeq++;
                        s.classes.push({ id: `c${classSeq}`, name: clean.name, address: clean.address, nodes: buildNodes(clean) });
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
        // node in or out; setSelection replaces the whole set (range selection / select-all).
        // isSelected drives the row highlight.
        selectNode(nodeId: string) {
            setStore("selectedNodeIds", [nodeId]);
        },
        toggleNode(nodeId: string) {
            setStore("selectedNodeIds", (ids) =>
                ids.includes(nodeId) ? ids.filter((id) => id !== nodeId) : [...ids, nodeId],
            );
        },
        setSelection(nodeIds: string[]) {
            setStore("selectedNodeIds", nodeIds);
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
        // a fresh class. Capped at AUTO_GROW_MAX so a class over live data can't grow without
        // bound; the Auto Grow toggle and pause/detach gating live in the caller (MemoryView).
        // Returns true when it grew, so the caller can throttle.
        autoGrowActiveClass(): boolean {
            const cls = activeClass();
            if (!cls || cls.nodes.length === 0) return false;
            const last = cls.nodes[cls.nodes.length - 1];
            if (isFill(last.typeId)) return false; // tail is still padding - room remains
            if (last.locked) return false; // a locked tail field opts the class out of growth
            if (totalSize(cls.nodes) >= AUTO_GROW_MAX) return false;
            updateNodes((nodes) => addBytes(nodes, AUTO_GROW_CHUNK));
            return true;
        },
        setNodeType(index: number, typeId: NodeTypeId, opts?: SetTypeOptions) {
            pushUndo();
            updateNodes((nodes) => setNodeType(nodes, index, typeId, opts));
        },
        clearNodeType(index: number) {
            pushUndo();
            updateNodes((nodes) => clearType(nodes, index));
        },
        /** Resize a string/ref field's byte span (user-configurable string length). */
        setNodeLength(index: number, length: number) {
            pushUndo();
            updateNodes((nodes) => setNodeLength(nodes, index, length));
        },
        /** Per-node display/endian/bit-name/lock overrides (no layout change). */
        setNodeMeta(index: number, patch: { displayFormat?: DisplayFormat; endian?: Endian; bitNames?: string[]; locked?: boolean }) {
            pushUndo();
            updateNodes((nodes) => setNodeMeta(nodes, index, patch));
        },
        /** Lock/unlock every selected node against automatic analysis. */
        setSelectedLocked(locked: boolean) {
            const ids = new Set(store.selectedNodeIds);
            if (ids.size === 0) return;
            pushUndo();
            updateNodes((nodes) =>
                nodes.map((n) => {
                    if (!ids.has(n.id)) return n;
                    const next = { ...n };
                    if (locked) next.locked = true;
                    else delete next.locked;
                    return next;
                }),
            );
        },
        // Apply auto-guess results: replace each planned tile with its guessed field(s). A guess
        // is only honored when the tile is STILL an untyped, unlocked fill of the planned byte
        // span - a guess can land a tick after the user has typed, locked, or resized that node
        // by hand, and their choice must win. Each replacement spans the same byte count, so
        // later offsets never move.
        applyGuesses(plan: Map<string, GuessField[]>) {
            if (plan.size === 0) return;
            pushUndo();
            updateNodes((nodes) =>
                nodes.flatMap((n) => {
                    const fields = plan.get(n.id);
                    if (!fields || fields.length === 0 || !isFill(n.typeId) || n.locked) return [n];
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
        setSelectedType(typeId: NodeTypeId, opts?: SetTypeOptions) {
            const ids = store.selectedNodeIds;
            if (ids.length === 0) return;
            pushUndo();
            updateNodes((nodes) => setNodeTypeForIds(nodes, ids, typeId, opts));
        },
        // Repeat the selected nodes `times` more times (array-of-struct). No-op if nothing selected.
        repeatSelection(times: number) {
            const ids = new Set(store.selectedNodeIds);
            if (ids.size === 0) return;
            pushUndo();
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
                picked.push(copyNode(n));
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
        // class). Selection is transient and never enters the stack; process-memory writes are
        // NOT layout mutations and never touch it either. Bounded at MAX_UNDO.
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
