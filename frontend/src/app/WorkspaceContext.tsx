import {
    createContext,
    createMemo,
    createSignal,
    useContext,
    type JSX,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { persist } from "../state/persist";
import type { ViewId } from "./AppContext";

// The workspace is a flat set of tabs, exactly like editor tabs in a desktop IDE. Tabs live in
// one or more groups; normally there is a single group (the whole strip). A second group only
// appears when the user explicitly sends a tab "to the side". Each group owns its own ordered
// tab list and its own active tab - a tab belongs to exactly one group, never rendered twice.

export type TabKind = ViewId | "sigscan" | "analysis" | "cheat" | "pe" | "bookmarks" | "diff" | "hex" | "regions" | "scanner" | "pointer" | "timeline" | "watch" | "emulator" | "patch" | "project" | "decompiler" | "network" | "debugger" | "hooklab";

export interface TabItem {
    id: string;
    kind: TabKind;
    /** Contextual label (e.g. a memory tab's class name). Falls back to the kind's default. */
    title?: string;
    /** For memory tabs: the class this tab is bound to. */
    classId?: string;
}

export interface TabGroup {
    id: string;
    tabs: TabItem[];
    activeTabId: string | null;
    /** Proportional flex-grow weight for side-by-side layout. Absent (legacy) means 1 - every
     *  group equal, exactly as before this field existed. Only the ratio between groups matters. */
    sizeWeight?: number;
}

interface WorkspaceStore {
    groups: TabGroup[];
    activeGroupId: string;
}

const STORAGE_KEY = "ax.workspace";
const STORAGE_VERSION = 2;

// Kinds that only ever make sense once - opening them again focuses the existing tab. Memory is
// the exception: multiple memory tabs (one per class/address) are a core workflow.
const SINGLETON_KINDS: ReadonlySet<TabKind> = new Set<TabKind>([
    "static",
    "strings",
    "history",
    "datatypes",
    "sigscan",
    "analysis",
    "cheat",
    "pe",
    "bookmarks",
    "diff",
    "hex",
    "regions",
    "scanner",
    "pointer",
    "timeline",
    "watch",
    "emulator",
    "patch",
    "project",
    "decompiler",
    "network",
    "debugger",
    "hooklab",
]);

const DEFAULT_KIND_TITLE: Record<TabKind, string> = {
    memory: "Memory Viewer",
    static: "Modules",
    strings: "Strings",
    history: "History",
    datatypes: "Data Types",
    sigscan: "Signature Scan",
    analysis: "Analysis",
    cheat: "Cheat Table",
    pe: "PE / Symbols",
    bookmarks: "Bookmarks",
    diff: "Snapshot Diff",
    hex: "Memory Inspector",
    regions: "Memory Map",
    scanner: "Value Scanner",
    pointer: "Pointer Chain",
    timeline: "Timeline",
    watch: "Memory Watch",
    emulator: "Emulator",
    patch: "Patches",
    project: "Project",
    decompiler: "Decompiler",
    network: "Network",
    debugger: "Debugger",
    hooklab: "Hook Lab",
};

export function defaultTabTitle(kind: TabKind): string {
    return DEFAULT_KIND_TITLE[kind] ?? "Tab";
}

let idSeq = 0;
function nextId(prefix: string): string {
    idSeq++;
    return `${prefix}_${Date.now().toString(36)}_${idSeq}`;
}

function newTab(kind: TabKind, title?: string, classId?: string): TabItem {
    return { id: nextId(`tab_${kind}`), kind, title, classId };
}

function freshWorkspace(): WorkspaceStore {
    const tabs = [newTab("memory"), newTab("static"), newTab("strings")];
    const group: TabGroup = { id: nextId("grp"), tabs, activeTabId: tabs[0].id };
    return { groups: [group], activeGroupId: group.id };
}

// ---- persistence / migration ------------------------------------------------

interface Envelope {
    v: number;
    data: unknown;
}

// Old v1 shape, kept only so a stored v1 workspace can be migrated forward.
interface LegacyV1 {
    tabs?: { id?: unknown; kind?: unknown; title?: unknown; classId?: unknown }[];
    activeTabId1?: unknown;
}

function isValidKind(k: unknown): k is TabKind {
    return typeof k === "string" && k in DEFAULT_KIND_TITLE;
}

function sanitizeTab(raw: unknown): TabItem | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== "string" || !isValidKind(t.kind)) return undefined;
    return {
        id: t.id,
        kind: t.kind,
        title: typeof t.title === "string" ? t.title : undefined,
        classId: typeof t.classId === "string" ? t.classId : undefined,
    };
}

function sanitizeGroup(raw: unknown): TabGroup | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const g = raw as Record<string, unknown>;
    if (typeof g.id !== "string" || !Array.isArray(g.tabs)) return undefined;
    const tabs = g.tabs.map(sanitizeTab).filter((t): t is TabItem => t !== undefined);
    if (tabs.length === 0) return undefined;
    const activeTabId = tabs.some((t) => t.id === g.activeTabId)
        ? (g.activeTabId as string)
        : tabs[0].id;
    const sizeWeight =
        typeof g.sizeWeight === "number" && isFinite(g.sizeWeight) && g.sizeWeight > 0
            ? g.sizeWeight
            : undefined;
    return { id: g.id, tabs, activeTabId, sizeWeight };
}

function migrateV1(data: LegacyV1): WorkspaceStore | undefined {
    if (!Array.isArray(data.tabs)) return undefined;
    const tabs = data.tabs.map(sanitizeTab).filter((t): t is TabItem => t !== undefined);
    if (tabs.length === 0) return undefined;
    const activeTabId = tabs.some((t) => t.id === data.activeTabId1)
        ? (data.activeTabId1 as string)
        : tabs[0].id;
    const group: TabGroup = { id: nextId("grp"), tabs, activeTabId };
    return { groups: [group], activeGroupId: group.id };
}

function hydrate(): WorkspaceStore | undefined {
    let env: Envelope | null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return undefined;
        env = JSON.parse(raw) as Envelope | null;
    } catch {
        return undefined;
    }
    if (!env || typeof env !== "object") return undefined;

    if (env.v === STORAGE_VERSION) {
        const data = env.data as { groups?: unknown; activeGroupId?: unknown };
        if (!data || !Array.isArray(data.groups)) return undefined;
        const groups = data.groups.map(sanitizeGroup).filter((g): g is TabGroup => g !== undefined);
        if (groups.length === 0) return undefined;
        const activeGroupId = groups.some((g) => g.id === data.activeGroupId)
            ? (data.activeGroupId as string)
            : groups[0].id;
        return { groups, activeGroupId };
    }

    if (env.v === 1) {
        try {
            return migrateV1(env.data as LegacyV1);
        } catch {
            return undefined;
        }
    }

    return undefined;
}

// ---- store ------------------------------------------------------------------

// A closed tab remembered for "reopen closed tab". Layout-only and in-memory (like a browser's
// recently-closed list): never persisted, capped so it cannot grow unbounded.
interface ClosedTab {
    kind: TabKind;
    title?: string;
    classId?: string;
}
const CLOSED_STACK_MAX = 20;

function createWorkspaceState() {
    const [store, setStore] = createStore<WorkspaceStore>(hydrate() ?? freshWorkspace());
    const [closedStack, setClosedStack] = createSignal<ClosedTab[]>([]);

    const rememberClosed = (tabs: TabItem[]) => {
        if (tabs.length === 0) return;
        setClosedStack((cur) => {
            const next = [...cur, ...tabs.map((t) => ({ kind: t.kind, title: t.title, classId: t.classId }))];
            return next.slice(Math.max(0, next.length - CLOSED_STACK_MAX));
        });
    };

    // Deep-read every field so the persist effect tracks nested leaves (a group's tabs, title,
    // activeTabId, sizeWeight). Reading only `store.groups` would subscribe to the array slot
    // alone, and a `produce` that mutates a nested property - reorder, rename, resize - would not
    // re-run this snapshot, so the change would never be written.
    persist(STORAGE_KEY, STORAGE_VERSION, () => ({
        groups: store.groups.map((g) => ({
            id: g.id,
            tabs: g.tabs.map((t) => ({ id: t.id, kind: t.kind, title: t.title, classId: t.classId })),
            activeTabId: g.activeTabId,
            sizeWeight: g.sizeWeight,
        })),
        activeGroupId: store.activeGroupId,
    }));

    const activeGroup = createMemo(
        () => store.groups.find((g) => g.id === store.activeGroupId) ?? store.groups[0],
    );
    const activeTab = createMemo(() => {
        const g = activeGroup();
        return g?.tabs.find((t) => t.id === g.activeTabId);
    });

    // Remove a group entirely, unless it is the only one (an empty workspace keeps one group so
    // there is always somewhere to open a tab). Reassigns the active group to a neighbour.
    function removeGroupIfEmpty(s: WorkspaceStore, groupId: string) {
        const idx = s.groups.findIndex((g) => g.id === groupId);
        if (idx < 0) return;
        if (s.groups[idx].tabs.length > 0) return;
        if (s.groups.length <= 1) return; // keep the last group as the empty workspace
        s.groups.splice(idx, 1);
        if (s.activeGroupId === groupId) {
            s.activeGroupId = s.groups[Math.min(idx, s.groups.length - 1)].id;
        }
    }

    // Pick the neighbour to activate after `closedIndex` is removed from `tabs`: prefer the tab
    // that was on the right, otherwise the new last tab. Null when the group is now empty.
    function neighbourAfterClose(tabs: TabItem[], closedIndex: number): string | null {
        if (tabs.length === 0) return null;
        return tabs[Math.min(closedIndex, tabs.length - 1)].id;
    }

    return {
        get groups() {
            return store.groups;
        },
        get activeGroupId() {
            return store.activeGroupId;
        },
        activeGroup,
        activeTab,

        tabById(id: string): TabItem | undefined {
            for (const g of store.groups) {
                const t = g.tabs.find((t) => t.id === id);
                if (t) return t;
            }
            return undefined;
        },

        focusGroup(groupId: string) {
            if (store.activeGroupId !== groupId) setStore("activeGroupId", groupId);
        },

        selectTab(tabId: string) {
            setStore(
                produce((s) => {
                    const g = s.groups.find((g) => g.tabs.some((t) => t.id === tabId));
                    if (!g) return;
                    g.activeTabId = tabId;
                    s.activeGroupId = g.id;
                }),
            );
        },

        // Add a new tab to the active group (or a given group) and focus it.
        addTab(kind: TabKind, opts?: { title?: string; classId?: string; groupId?: string }): string {
            const tab = newTab(kind, opts?.title, opts?.classId);
            setStore(
                produce((s) => {
                    const targetId = opts?.groupId ?? s.activeGroupId;
                    const g = s.groups.find((g) => g.id === targetId) ?? s.groups[0];
                    g.tabs.push(tab);
                    g.activeTabId = tab.id;
                    s.activeGroupId = g.id;
                }),
            );
            return tab.id;
        },

        closeTab(tabId: string) {
            const closed = this.tabById(tabId);
            if (closed) rememberClosed([closed]);
            setStore(
                produce((s) => {
                    const g = s.groups.find((g) => g.tabs.some((t) => t.id === tabId));
                    if (!g) return;
                    const idx = g.tabs.findIndex((t) => t.id === tabId);
                    g.tabs.splice(idx, 1);
                    if (g.activeTabId === tabId) {
                        g.activeTabId = neighbourAfterClose(g.tabs, idx);
                    }
                    removeGroupIfEmpty(s, g.id);
                }),
            );
        },

        closeOtherTabs(tabId: string) {
            const g0 = store.groups.find((g) => g.tabs.some((t) => t.id === tabId));
            if (g0) rememberClosed(g0.tabs.filter((t) => t.id !== tabId));
            setStore(
                produce((s) => {
                    const g = s.groups.find((g) => g.tabs.some((t) => t.id === tabId));
                    if (!g) return;
                    const kept = g.tabs.find((t) => t.id === tabId);
                    if (!kept) return;
                    g.tabs = [kept];
                    g.activeTabId = tabId;
                }),
            );
        },

        closeTabsToRight(tabId: string) {
            const g0 = store.groups.find((g) => g.tabs.some((t) => t.id === tabId));
            if (g0) {
                const at = g0.tabs.findIndex((t) => t.id === tabId);
                if (at >= 0) rememberClosed(g0.tabs.slice(at + 1));
            }
            setStore(
                produce((s) => {
                    const g = s.groups.find((g) => g.tabs.some((t) => t.id === tabId));
                    if (!g) return;
                    const idx = g.tabs.findIndex((t) => t.id === tabId);
                    if (idx < 0) return;
                    g.tabs = g.tabs.slice(0, idx + 1);
                    if (!g.tabs.some((t) => t.id === g.activeTabId)) g.activeTabId = tabId;
                }),
            );
        },

        canReopen: () => closedStack().length > 0,

        // Reopen the most recently closed tab in the active group, restoring its kind/title/class.
        reopenClosedTab() {
            const stack = closedStack();
            if (stack.length === 0) return;
            const last = stack[stack.length - 1];
            setClosedStack(stack.slice(0, -1));
            this.addTab(last.kind, { title: last.title, classId: last.classId });
        },

        // Commit new proportional weights for an adjacent pair after a divider drag. Only the two
        // groups touched change; every other group keeps its weight, so their pixel widths hold.
        // Values are stored raw (they are flex-grow numbers) - only the ratio between them matters.
        resizeGroups(leftId: string, rightId: string, leftWeight: number, rightWeight: number) {
            if (!(leftWeight > 0) || !(rightWeight > 0)) return;
            setStore(
                produce((s) => {
                    const l = s.groups.find((g) => g.id === leftId);
                    const r = s.groups.find((g) => g.id === rightId);
                    if (!l || !r) return;
                    l.sizeWeight = leftWeight;
                    r.sizeWeight = rightWeight;
                }),
            );
        },

        // Reorder a tab within its group from one index to another (drag-to-reorder).
        moveTab(groupId: string, fromIndex: number, toIndex: number) {
            setStore(
                produce((s) => {
                    const g = s.groups.find((g) => g.id === groupId);
                    if (!g) return;
                    if (
                        fromIndex < 0 ||
                        fromIndex >= g.tabs.length ||
                        toIndex < 0 ||
                        toIndex >= g.tabs.length ||
                        fromIndex === toIndex
                    )
                        return;
                    const [moved] = g.tabs.splice(fromIndex, 1);
                    g.tabs.splice(toIndex, 0, moved);
                }),
            );
        },

        duplicateTab(tabId: string) {
            setStore(
                produce((s) => {
                    const g = s.groups.find((g) => g.tabs.some((t) => t.id === tabId));
                    if (!g) return;
                    const idx = g.tabs.findIndex((t) => t.id === tabId);
                    const src = g.tabs[idx];
                    const copy = newTab(src.kind, src.title, src.classId);
                    g.tabs.splice(idx + 1, 0, copy);
                    g.activeTabId = copy.id;
                    s.activeGroupId = g.id;
                }),
            );
        },

        // Move a tab into a side group (creating one if needed), so two views sit side by side.
        moveTabToSide(tabId: string) {
            setStore(
                produce((s) => {
                    const from = s.groups.find((g) => g.tabs.some((t) => t.id === tabId));
                    if (!from) return;
                    const idx = from.tabs.findIndex((t) => t.id === tabId);
                    const [tab] = from.tabs.splice(idx, 1);
                    if (from.activeTabId === tabId) {
                        from.activeTabId = neighbourAfterClose(from.tabs, idx);
                    }

                    // Target the next group after `from`, or make a new one on the right.
                    const fromIdx = s.groups.findIndex((g) => g.id === from.id);
                    let target = s.groups[fromIdx + 1];
                    if (!target) {
                        target = { id: nextId("grp"), tabs: [], activeTabId: null };
                        s.groups.splice(fromIdx + 1, 0, target);
                    }
                    target.tabs.push(tab);
                    target.activeTabId = tab.id;
                    s.activeGroupId = target.id;

                    removeGroupIfEmpty(s, from.id);
                }),
            );
        },

        setTabTitle(tabId: string, title: string) {
            const trimmed = title.trim();
            setStore(
                produce((s) => {
                    for (const g of s.groups) {
                        const t = g.tabs.find((t) => t.id === tabId);
                        if (t) {
                            t.title = trimmed || undefined;
                            return;
                        }
                    }
                }),
            );
        },

        setTabClass(tabId: string, classId: string) {
            setStore(
                produce((s) => {
                    for (const g of s.groups) {
                        const t = g.tabs.find((t) => t.id === tabId);
                        if (t) {
                            t.classId = classId;
                            return;
                        }
                    }
                }),
            );
        },

        // Open a view, focusing an existing tab where that is the right behaviour. Singleton kinds
        // (Strings, Modules, ...) reuse their one tab wherever it lives. Memory reuses the active
        // memory tab if there is one - so a jump lands in place instead of spawning duplicates -
        // and otherwise opens a fresh one. A supplied classId re-binds the target memory tab.
        openOrFocusView(kind: TabKind, classId?: string) {
            if (SINGLETON_KINDS.has(kind)) {
                let found: TabItem | undefined;
                for (const g of store.groups) {
                    const t = g.tabs.find((t) => t.kind === kind);
                    if (t) {
                        found = t;
                        break;
                    }
                }
                if (found) {
                    if (classId) this.setTabClass(found.id, classId);
                    this.selectTab(found.id);
                } else {
                    this.addTab(kind, { classId });
                }
                return;
            }

            // memory (multi-instance): prefer the active tab if it is already memory, else any
            // memory tab in the active group, else any memory tab, else create one.
            const g = activeGroup();
            const active = g?.tabs.find((t) => t.id === g.activeTabId);
            let target: TabItem | undefined =
                active && active.kind === kind ? active : g?.tabs.find((t) => t.kind === kind);
            if (!target) {
                for (const grp of store.groups) {
                    const t = grp.tabs.find((t) => t.kind === kind);
                    if (t) {
                        target = t;
                        break;
                    }
                }
            }
            if (target) {
                if (classId) this.setTabClass(target.id, classId);
                this.selectTab(target.id);
            } else {
                this.addTab(kind, { classId });
            }
        },
    };
}

export type WorkspaceState = ReturnType<typeof createWorkspaceState>;

const WorkspaceContext = createContext<WorkspaceState>();

export function WorkspaceProvider(props: { children: JSX.Element }) {
    const state = createWorkspaceState();
    return <WorkspaceContext.Provider value={state}>{props.children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
    const state = useContext(WorkspaceContext);
    if (!state) throw new Error("useWorkspace must be used within a WorkspaceProvider");
    return state;
}
