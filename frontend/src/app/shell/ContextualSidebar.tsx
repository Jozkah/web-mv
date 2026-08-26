import { For, Show } from "solid-js";
import { Icon } from "../workspace/icons";
import { useShell, clampWidth } from "./ShellContext";
import { useWorkspace, type TabKind } from "../WorkspaceContext";
import { useApp } from "../AppContext";
import { categoryById } from "./categories";

// The contextual sidebar: content for the selected activity. Every category lists its views as a
// navigable list (click opens/focuses the tab). Organize also surfaces saved targets. Memory
// classes are intentionally NOT listed here — the Memory Viewer has its own class sidebar, so
// duplicating it would waste width. The panel is resizable via the drag handle on its right edge,
// and its width + visibility persist.

export function ContextualSidebar() {
    const shell = useShell();
    const ws = useWorkspace();
    const app = useApp();

    const category = () => categoryById(shell.category());
    const activeKind = () => ws.activeTab()?.kind;

    const open = (kind: TabKind) => {
        // Signature Scan opens as a workspace tab here so it still has a home in the Search category
        // (the floating window stays reachable from the app bar / palette).
        ws.openOrFocusView(kind);
    };

    // ---- resize -------------------------------------------------------------
    const startResize = (e: PointerEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = shell.sidebarWidth();
        const onMove = (ev: PointerEvent) => shell.setSidebarWidth(clampWidth(startW + (ev.clientX - startX)));
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <aside class="sidebar" style={{ width: `${shell.sidebarWidth()}px` }} aria-label={`${category().label} sidebar`}>
            <div class="sidebar-inner">
                <header class="sidebar-head">
                    <span class="sidebar-title">{category().label}</span>
                    <button
                        class="sidebar-collapse"
                        aria-label="Collapse sidebar"
                        title="Collapse sidebar"
                        onClick={() => shell.setSidebarOpen(false)}
                    >
                        <Icon name="sidebar" size={15} />
                    </button>
                </header>

                <div class="sidebar-scroll">
                    <section class="sidebar-section">
                        <div class="sidebar-section-head">Views</div>
                        <For each={category().views}>
                            {(v) => (
                                <button
                                    class="sidebar-row"
                                    classList={{ active: activeKind() === v.kind }}
                                    onClick={() => open(v.kind)}
                                    title={v.hint}
                                >
                                    <Icon name={v.kind === "sigscan" ? "sigscan" : v.kind} size={15} />
                                    <span class="sidebar-row-label">{v.label}</span>
                                </button>
                            )}
                        </For>
                    </section>

                    {/* Organize: saved targets, so a historical workspace is reachable from here too. */}
                    <Show when={shell.category() === "organize"}>
                        <section class="sidebar-section">
                            <div class="sidebar-section-head">Targets</div>
                            <button
                                class="sidebar-row"
                                classList={{ active: app.isFollowingLive() }}
                                onClick={() => app.followLive()}
                                title="Follow the attached process"
                            >
                                <span class="dot" classList={{ live: app.attached() }} />
                                <span class="sidebar-row-label">Follow Live</span>
                            </button>
                            <For each={app.targets()}>
                                {(t) => (
                                    <button
                                        class="sidebar-row"
                                        classList={{ active: !app.isFollowingLive() && app.workspaceKey() === t.key }}
                                        onClick={() => app.selectTarget(t.key)}
                                        title="View this saved target's workspace"
                                    >
                                        <span class="dot" />
                                        <span class="sidebar-row-label">{t.pid !== undefined ? `pid ${t.pid}` : t.key}</span>
                                    </button>
                                )}
                            </For>
                        </section>
                    </Show>
                </div>
            </div>
            <div
                class="sidebar-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                onPointerDown={startResize}
            />
        </aside>
    );
}
