import { Show } from "solid-js";
import { useApp } from "./AppContext";
import { useWorkspace } from "./WorkspaceContext";
import { useMemory } from "../views/memory/state/MemoryContext";
import { exportSession, importSession } from "../state/session";
import { downloadText, pickTextFile } from "../state/fileio";
import { Icon } from "./workspace/icons";
import { NavControls } from "./NavControls";

// The application top bar: global tool actions (signature scan window, SigMaker) on the left and
// process / connection status on the right. Workspace layout is no longer configured here - tabs
// are the whole model, so there is nothing to toggle.

export function TopBar(props: { sigScanOpen: boolean; onToggleSigScan: () => void }) {
    const app = useApp();
    const ws = useWorkspace();
    const memory = useMemory();

    const agentUp = () => app.pingData() !== undefined;
    const agentCount = () => app.activeAgents();

    const stores = () => ({ cheat: app.cheat, bookmarks: app.bookmarks, memory });
    const saveSession = () => downloadText("web-mv-session.json", exportSession(stores()));
    const loadSession = async () => {
        const text = await pickTextFile();
        if (text === undefined) return;
        try {
            importSession(text, stores());
        } catch {
            /* malformed file - ignore, per-store imports are best-effort */
        }
    };

    return (
        <header class="topbar">
            <nav class="topbar-nav">
                <button
                    classList={{ active: props.sigScanOpen }}
                    onClick={props.onToggleSigScan}
                    title="Toggle the Signature Scan window (data is preserved on close)"
                >
                    <Icon name="sigscan" size={15} />
                    Signature scan
                </button>

                <button
                    title="Generate a unique IDA signature pattern for a function"
                    onClick={() => ws.openOrFocusView("static")}
                >
                    <Icon name="static" size={15} />
                    SigMaker
                </button>

                <NavControls />

                <button title="Save the whole session (classes + cheats + bookmarks) to a file" onClick={saveSession}>
                    <Icon name="static" size={15} />
                    Save session
                </button>
                <button title="Load a saved session file (merges into the current one)" onClick={loadSession}>
                    Load session
                </button>
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
                <span
                    class="badge"
                    classList={{ up: app.extConnected() }}
                    title="Extension agent (write / dump / exports / sections). Load web_mv_ext_agent.as to enable memory writing."
                >
                    ext: {app.extConnected() ? "up" : "down"}
                </span>
            </div>
        </header>
    );
}
