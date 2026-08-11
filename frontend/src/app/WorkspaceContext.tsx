import {
    createContext,
    createMemo,
    useContext,
    type JSX,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { load, persist } from "../state/persist";
import type { ViewId } from "./AppContext";

export type TabKind = ViewId | "sigscan";
export type LayoutMode = "single" | "split-h" | "split-v";

export interface TabItem {
    id: string;
    kind: TabKind;
    title: string;
    classId?: string;
}

interface WorkspaceStore {
    tabs: TabItem[];
    activeTabId1: string;
    activeTabId2: string;
    layout: LayoutMode;
    focusedPanel: 1 | 2;
}

const STORAGE_KEY = "ax.workspace";
const STORAGE_VERSION = 1;

function defaultTabTitle(kind: TabKind, classId?: string): string {
    switch (kind) {
        case "memory":
            return classId ? `Memory (${classId})` : "Memory viewer";
        case "static":
            return "Modules";
        case "strings":
            return "Strings";
        case "history":
            return "History";
        case "sigscan":
            return "Sig scan";
        default:
            return "Tab";
    }
}

const DEFAULT_TABS: TabItem[] = [
    { id: "tab_memory", kind: "memory", title: "Memory viewer" },
    { id: "tab_static", kind: "static", title: "Modules" },
    { id: "tab_strings", kind: "strings", title: "Strings" },
];

function hydrate(): WorkspaceStore | undefined {
    const saved = load<WorkspaceStore>(STORAGE_KEY, STORAGE_VERSION);
    if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) return undefined;
    
    // Ensure all tabs are valid
    const tabs = saved.tabs.filter(
        (t) => t && typeof t.id === "string" && typeof t.kind === "string"
    );
    if (tabs.length === 0) return undefined;

    const activeTabId1 = tabs.some((t) => t.id === saved.activeTabId1)
        ? saved.activeTabId1
        : tabs[0].id;

    const activeTabId2 = tabs.some((t) => t.id === saved.activeTabId2)
        ? saved.activeTabId2
        : tabs[1]?.id ?? tabs[0].id;

    const layout: LayoutMode =
        saved.layout === "split-h" || saved.layout === "split-v" ? saved.layout : "single";

    const focusedPanel: 1 | 2 = saved.focusedPanel === 2 ? 2 : 1;

    return { tabs, activeTabId1, activeTabId2, layout, focusedPanel };
}

function createWorkspaceState() {
    const initial: WorkspaceStore = hydrate() ?? {
        tabs: DEFAULT_TABS,
        activeTabId1: "tab_memory",
        activeTabId2: "tab_static",
        layout: "single",
        focusedPanel: 1,
    };

    const [store, setStore] = createStore<WorkspaceStore>(initial);

    persist(STORAGE_KEY, STORAGE_VERSION, () => ({
        tabs: store.tabs,
        activeTabId1: store.activeTabId1,
        activeTabId2: store.activeTabId2,
        layout: store.layout,
        focusedPanel: store.focusedPanel,
    }));

    const activeTab1 = createMemo(
        () => store.tabs.find((t) => t.id === store.activeTabId1) ?? store.tabs[0]
    );

    const activeTab2 = createMemo(
        () => store.tabs.find((t) => t.id === store.activeTabId2) ?? store.tabs[0]
    );

    let tabSeq = Date.now();

    return {
        get tabs() {
            return store.tabs;
        },
        get activeTabId1() {
            return store.activeTabId1;
        },
        get activeTabId2() {
            return store.activeTabId2;
        },
        get layout() {
            return store.layout;
        },
        get focusedPanel() {
            return store.focusedPanel;
        },
        activeTab1,
        activeTab2,

        setFocusedPanel(panel: 1 | 2) {
            setStore("focusedPanel", panel);
        },

        selectTab(id: string, panel?: 1 | 2) {
            const targetPanel = panel ?? store.focusedPanel;
            setStore(produce((s) => {
                s.focusedPanel = targetPanel;
                if (targetPanel === 1) s.activeTabId1 = id;
                else s.activeTabId2 = id;
            }));
        },

        addTab(kind: TabKind, title?: string, classId?: string, targetPanel?: 1 | 2): string {
            tabSeq++;
            const id = `tab_${kind}_${tabSeq}`;
            const label = title ?? defaultTabTitle(kind, classId);
            const newTab: TabItem = { id, kind, title: label, classId };
            const destPanel = targetPanel ?? store.focusedPanel;

            setStore(produce((s) => {
                s.tabs.push(newTab);
                s.focusedPanel = destPanel;
                if (destPanel === 1) s.activeTabId1 = id;
                else s.activeTabId2 = id;
            }));
            return id;
        },

        closeTab(id: string) {
            setStore(produce((s) => {
                if (s.tabs.length <= 1) {
                    // Don't leave an empty workspace; replace with default memory tab
                    const replacement: TabItem = {
                        id: `tab_memory_${Date.now()}`,
                        kind: "memory",
                        title: "Memory viewer",
                    };
                    s.tabs = [replacement];
                    s.activeTabId1 = replacement.id;
                    s.activeTabId2 = replacement.id;
                    return;
                }

                const index = s.tabs.findIndex((t) => t.id === id);
                if (index < 0) return;

                s.tabs.splice(index, 1);
                const nextTab = s.tabs[Math.min(index, s.tabs.length - 1)];

                if (s.activeTabId1 === id) {
                    s.activeTabId1 = nextTab.id;
                }
                if (s.activeTabId2 === id) {
                    s.activeTabId2 = nextTab.id;
                }
            }));
        },

        setLayout(mode: LayoutMode) {
            setStore(produce((s) => {
                s.layout = mode;
                if (mode !== "single" && s.activeTabId1 === s.activeTabId2 && s.tabs.length > 1) {
                    const secondary = s.tabs.find((t) => t.id !== s.activeTabId1);
                    if (secondary) s.activeTabId2 = secondary.id;
                }
            }));
        },

        openOrFocusView(kind: TabKind, classId?: string) {
            const destPanel = store.focusedPanel;
            const currentActiveId = destPanel === 1 ? store.activeTabId1 : store.activeTabId2;
            const currentActiveTab = store.tabs.find((t) => t.id === currentActiveId);

            if (currentActiveTab && currentActiveTab.kind === kind) {
                if (classId) {
                    setStore("tabs", (t) => t.id === currentActiveId, "classId", classId);
                }
                return;
            }

            const existing = store.tabs.find((t) => t.kind === kind);
            if (existing) {
                if (classId) {
                    setStore("tabs", (t) => t.id === existing.id, "classId", classId);
                }
                this.selectTab(existing.id, destPanel);
            } else {
                this.addTab(kind, undefined, classId, destPanel);
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
