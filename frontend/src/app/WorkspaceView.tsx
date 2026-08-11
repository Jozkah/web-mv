import { Match, Show, Switch, createMemo } from "solid-js";
import { useWorkspace, type TabItem } from "./WorkspaceContext";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import { MemoryView } from "../views/memory/MemoryView";
import { StaticView } from "../views/static/StaticView";
import { StringsView } from "../views/strings/StringsView";
import { HistoryView } from "../views/history/HistoryView";
import { ScanCard } from "../scan/ScanCard";
import "./workspace.css";

export function WorkspaceView() {
    const ws = useWorkspace();

    return (
        <div class="workspace-container">
            <div
                class="workspace-main"
                classList={{
                    "split-h": ws.layout === "split-h",
                    "split-v": ws.layout === "split-v",
                }}
            >
                {/* Panel 1 */}
                <div
                    class="workspace-panel"
                    classList={{ focused: ws.focusedPanel === 1 }}
                    onClick={() => ws.setFocusedPanel(1)}
                >
                    <WorkspaceTabBar panel={1} />
                    <div class="panel-viewport">
                        <TabContent tab={ws.activeTab1()} />
                    </div>
                </div>

                {/* Panel 2 (if split view) */}
                <Show when={ws.layout !== "single"}>
                    <div
                        class="workspace-panel"
                        classList={{ focused: ws.focusedPanel === 2 }}
                        onClick={() => ws.setFocusedPanel(2)}
                    >
                        <WorkspaceTabBar panel={2} />
                        <div class="panel-viewport">
                            <TabContent tab={ws.activeTab2()} />
                        </div>
                    </div>
                </Show>
            </div>
        </div>
    );
}

/**
 * Renders the view for a given tab. Uses a keyed memo on tab.id so that switching
 * between two tabs of the same kind (e.g. two Memory Viewer tabs) correctly remounts
 * the component, preventing state leakage between tabs.
 */
function TabContent(props: { tab: TabItem | undefined }) {
    // Create a composite key from tab id. When it changes, the inner Show/keyed
    // will remount its children, isolating per-tab state.
    const tabKey = createMemo(() => props.tab?.id);

    return (
        <Show when={tabKey()} keyed>
            {(_id) => {
                const tab = props.tab!;
                return (
                    <Switch>
                        <Match when={tab.kind === "memory"}>
                            <MemoryView classId={tab.classId} />
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
                        <Match when={tab.kind === "sigscan"}>
                            <div style={{ flex: "1 1 auto", display: "flex", padding: "12px", "min-height": 0 }}>
                                <ScanCard kind="sig" onClose={() => {}} />
                            </div>
                        </Match>
                    </Switch>
                );
            }}
        </Show>
    );
}
