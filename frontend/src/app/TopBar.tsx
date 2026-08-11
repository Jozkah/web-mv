import { Show } from "solid-js";
import { useApp } from "./AppContext";
import { useWorkspace } from "./WorkspaceContext";

// The application top bar: agent/relay status, floating scan window toggles, and workspace split layout controls.

export function TopBar(props: { sigScanOpen: boolean; onToggleSigScan: () => void }) {
    const app = useApp();
    const ws = useWorkspace();

    const agentUp = () => app.pingData() !== undefined;
    const agentCount = () => app.activeAgents();

    return (
        <header class="topbar">
            <nav class="topbar-nav">
                <button
                    classList={{ active: props.sigScanOpen }}
                    onClick={props.onToggleSigScan}
                    title="Toggle Signature Scan window (data is preserved on close)"
                >
                    🎯 Signature scan
                </button>

                <button
                    title="Generate unique IDA signature pattern for function"
                    onClick={() => {
                        ws.openOrFocusView("static");
                    }}
                >
                    ⚡ SigMaker
                </button>

                <span class="topbar-sep" />

                <div class="layout-toggles" title="Workspace layout">
                    <button
                        class="layout-btn"
                        classList={{ active: ws.layout === "single" }}
                        onClick={() => ws.setLayout("single")}
                        title="Single panel layout"
                    >
                        🗂 Single
                    </button>
                    <button
                        class="layout-btn"
                        classList={{ active: ws.layout === "split-h" }}
                        onClick={() => ws.setLayout("split-h")}
                        title="Split side-by-side"
                    >
                        ║ Split
                    </button>
                    <button
                        class="layout-btn"
                        classList={{ active: ws.layout === "split-v" }}
                        onClick={() => ws.setLayout("split-v")}
                        title="Split top/bottom"
                    >
                        ═ Stack
                    </button>
                </div>
            </nav>

            <div class="topbar-status">
                <Show when={app.attached()}>
                    <span class="proc">
                        pid {app.pid()} · base {app.base()}
                    </span>
                </Show>
                <span class="badge" classList={{ up: app.relayStatus() === "open" }}>
                    server: {app.relayStatus()}
                </span>
                <span class="badge" classList={{ up: agentUp() }}>
                    <Show
                        when={agentCount() > 1}
                        fallback={<>agent: {agentUp() ? "up" : "down"}</>}
                    >
                        agents: {agentCount()}
                    </Show>
                </span>
            </div>
        </header>
    );
}
