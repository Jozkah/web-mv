import { Match, Show, Switch } from "solid-js";
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

function TabContent(props: { tab: TabItem | undefined }) {
    return (
        <Switch>
            <Match when={props.tab?.kind === "memory"}>
                <MemoryView classId={props.tab?.classId} />
            </Match>
            <Match when={props.tab?.kind === "static"}>
                <StaticView />
            </Match>
            <Match when={props.tab?.kind === "strings"}>
                <StringsView />
            </Match>
            <Match when={props.tab?.kind === "history"}>
                <HistoryView />
            </Match>
            <Match when={props.tab?.kind === "sigscan"}>
                <div style={{ flex: "1 1 auto", display: "flex", padding: "12px", "min-height": 0 }}>
                    <ScanCard kind="sig" onClose={() => {}} />
                </div>
            </Match>
        </Switch>
    );
}
