import { For, Match, Show, Switch, createMemo, onCleanup, onMount } from "solid-js";
import { useWorkspace, type TabGroup, type TabItem, type TabKind } from "./WorkspaceContext";
import { TabBar } from "./workspace/TabBar";
import { WorkspaceEmptyState } from "./workspace/WorkspaceEmptyState";
import { MemoryView } from "../views/memory/MemoryView";
import { StaticView } from "../views/static/StaticView";
import { StringsView } from "../views/strings/StringsView";
import { HistoryView } from "../views/history/HistoryView";
import { AnalysisView } from "../views/analysis/AnalysisView";
import { DataTypesView } from "../views/datatypes/DataTypesView";
import { ScanCard } from "../scan/ScanCard";
import { CheatView } from "../views/cheat/CheatView";
import { PeView } from "../views/pe/PeView";
import { BookmarksView } from "../views/bookmarks/BookmarksView";
import { SnapshotDiffView } from "../views/diff/SnapshotDiffView";
import { HexView } from "../views/hex/HexView";
import { RegionsView } from "../views/regions/RegionsView";
import { ScannerView } from "../views/scanner/ScannerView";
import { PointerView } from "../views/pointer/PointerView";
import "./workspace.css";

export function WorkspaceView() {
    const ws = useWorkspace();

    // Keyboard quality-of-life: close / cycle tabs within the focused group.
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            const group = ws.activeGroup();
            if (!group) return;

            if (mod && (e.key === "w" || e.key === "W")) {
                if (group.activeTabId) {
                    e.preventDefault();
                    ws.closeTab(group.activeTabId);
                }
                return;
            }
            if (e.ctrlKey && e.key === "Tab") {
                const tabs = group.tabs;
                if (tabs.length < 2) return;
                e.preventDefault();
                const cur = tabs.findIndex((t) => t.id === group.activeTabId);
                const dir = e.shiftKey ? -1 : 1;
                const next = tabs[(cur + dir + tabs.length) % tabs.length];
                ws.selectTab(next.id);
            }
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    return (
        <div class="workspace" classList={{ split: ws.groups.length > 1 }}>
            <For each={ws.groups}>
                {(group) => (
                    <section
                        class="ws-group"
                        classList={{ focused: group.id === ws.activeGroupId }}
                        onPointerDown={() => ws.focusGroup(group.id)}
                    >
                        <TabBar group={group} />
                        <div class="ws-viewport">
                            <GroupContent group={group} focused={group.id === ws.activeGroupId} />
                        </div>
                    </section>
                )}
            </For>
        </div>
    );
}

// Renders the active tab of a group. Keyed on the active tab id so switching tabs remounts the
// view - which is what keeps each view's live poll scoped to only the tab that's showing. Durable
// per-view state (class definitions, string results, annotations) lives in providers above this
// switch, so remounting never loses it.
function GroupContent(props: { group: TabGroup; focused: boolean }) {
    const ws = useWorkspace();
    const activeTab = createMemo(() =>
        props.group.tabs.find((t) => t.id === props.group.activeTabId),
    );

    return (
        <Show when={activeTab()} fallback={<WorkspaceEmptyState onOpen={(k: TabKind) => ws.openOrFocusView(k)} />}>
            <Show when={activeTab()!.id} keyed>
                {(_id) => <TabContent tab={activeTab()!} focused={props.focused} />}
            </Show>
        </Show>
    );
}

function TabContent(props: { tab: TabItem; focused: boolean }) {
    const ws = useWorkspace();
    const tab = props.tab;
    return (
        <Switch>
            <Match when={tab.kind === "memory"}>
                <MemoryView
                    classId={tab.classId}
                    tabId={tab.id}
                    canBind={props.focused}
                    onBindClass={(id) => ws.setTabClass(tab.id, id)}
                    onTitle={(t) => ws.setTabTitle(tab.id, t)}
                />
            </Match>
            <Match when={tab.kind === "static"}>
                <StaticView />
            </Match>
            <Match when={tab.kind === "strings"}>
                <StringsView />
            </Match>
            <Match when={tab.kind === "history"}>
                <HistoryView />
            </Match>
            <Match when={tab.kind === "analysis"}>
                <AnalysisView />
            </Match>
            <Match when={tab.kind === "datatypes"}>
                <DataTypesView />
            </Match>
            <Match when={tab.kind === "cheat"}>
                <CheatView />
            </Match>
            <Match when={tab.kind === "pe"}>
                <PeView />
            </Match>
            <Match when={tab.kind === "bookmarks"}>
                <BookmarksView />
            </Match>
            <Match when={tab.kind === "diff"}>
                <SnapshotDiffView />
            </Match>
            <Match when={tab.kind === "hex"}>
                <HexView />
            </Match>
            <Match when={tab.kind === "regions"}>
                <RegionsView />
            </Match>
            <Match when={tab.kind === "scanner"}>
                <ScannerView />
            </Match>
            <Match when={tab.kind === "pointer"}>
                <PointerView />
            </Match>
            <Match when={tab.kind === "sigscan"}>
                <div style={{ flex: "1 1 auto", display: "flex", padding: "12px", "min-height": 0 }}>
                    <ScanCard kind="sig" onClose={() => {}} />
                </div>
            </Match>
        </Switch>
    );
}
