import { For, Show, createSignal } from "solid-js";
import { useWorkspace, type TabKind } from "./WorkspaceContext";

export function getTabIcon(kind: TabKind): string {
    switch (kind) {
        case "memory":
            return "🧠";
        case "static":
            return "⚡";
        case "strings":
            return "🧵";
        case "history":
            return "📜";
        case "sigscan":
            return "🎯";
    }
    return "📄";
}

export function WorkspaceTabBar(props: { panel: 1 | 2 }) {
    const ws = useWorkspace();
    const [menuOpen, setMenuOpen] = createSignal(false);

    const activeTabId = () => (props.panel === 1 ? ws.activeTabId1 : ws.activeTabId2);

    const handleAdd = (kind: TabKind) => {
        setMenuOpen(false);
        ws.addTab(kind, undefined, undefined, props.panel);
    };

    return (
        <header
            class="workspace-tabbar"
            onClick={() => ws.setFocusedPanel(props.panel)}
        >
            <div class="workspace-tabs-scroll">
                <For each={ws.tabs}>
                    {(tab) => (
                        <div
                            class="ws-tab"
                            classList={{ active: activeTabId() === tab.id }}
                            onClick={() => ws.selectTab(tab.id, props.panel)}
                            title={tab.title}
                        >
                            <span class="tab-icon">{getTabIcon(tab.kind)}</span>
                            <span class="tab-title">{tab.title}</span>
                            <span
                                class="tab-close"
                                title="Close tab"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    ws.closeTab(tab.id);
                                }}
                            >
                                ×
                            </span>
                        </div>
                    )}
                </For>
            </div>

            <div class="ws-tab-add-wrap">
                <button
                    class="ws-tab-add-btn"
                    title="Open new tab"
                    onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpen((cur) => !cur);
                    }}
                >
                    +
                </button>

                <Show when={menuOpen()}>
                    <div
                        class="ws-tab-menu-backdrop"
                        onClick={() => setMenuOpen(false)}
                    />
                    <div class="ws-tab-menu">
                        <button
                            class="ws-tab-menu-item"
                            onClick={() => handleAdd("memory")}
                        >
                            <span class="tab-icon">🧠</span> Memory viewer
                        </button>
                        <button
                            class="ws-tab-menu-item"
                            onClick={() => handleAdd("static")}
                        >
                            <span class="tab-icon">⚡</span> Modules
                        </button>
                        <button
                            class="ws-tab-menu-item"
                            onClick={() => handleAdd("strings")}
                        >
                            <span class="tab-icon">🧵</span> Strings
                        </button>
                        <button
                            class="ws-tab-menu-item"
                            onClick={() => handleAdd("history")}
                        >
                            <span class="tab-icon">📜</span> History
                        </button>
                        <button
                            class="ws-tab-menu-item"
                            onClick={() => handleAdd("sigscan")}
                        >
                            <span class="tab-icon">🎯</span> Signature scan
                        </button>
                    </div>
                </Show>
            </div>
        </header>
    );
}
