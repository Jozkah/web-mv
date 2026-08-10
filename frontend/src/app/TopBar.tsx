import { For, Show } from "solid-js";
import { useApp, type ViewId } from "./AppContext";
import type { ScanKind } from "../scan/ScanCard";

// The application top bar: destination tabs on the left, agent/relay status on the right.
// The destinations are the app's top-level pages; activeView (in AppContext) owns which is
// shown. Sig/String Scan are not pages - they are cards that pop down from their own toggle
// buttons here over whichever page is active (see Shell), so the shell drives them by props.

const VIEWS: ReadonlyArray<{ id: ViewId; label: string }> = [
    { id: "memory", label: "Memory viewer" },
    { id: "static", label: "Modules" },
    { id: "strings", label: "Strings" },
];

const CARDS: ReadonlyArray<{ kind: ScanKind; label: string }> = [
    { kind: "sig", label: "Signature scan" },
];

export function TopBar(props: { openCard: ScanKind | null; onToggleCard: (kind: ScanKind) => void }) {
    const app = useApp();
    const moduleCount = () => app.modules.list().length;
    const agentUp = () => app.pingData() !== undefined;
    // Once more than one RPC caller (chat) is active, the badge shows the count instead of a
    // plain up/down - a solo session still reads as "agent: up".
    const agentCount = () => app.activeAgents();

    return (
        <header class="topbar">
            <nav class="topbar-nav">
                <For each={VIEWS}>
                    {(view) => (
                        <button
                            classList={{ active: app.activeView() === view.id }}
                            onClick={() => app.setActiveView(view.id)}
                        >
                            {view.label}
                            <Show when={view.id === "static" && moduleCount() > 0}>
                                {" "}
                                ({moduleCount()})
                            </Show>
                        </button>
                    )}
                </For>

                <span class="topbar-sep" />

                <For each={CARDS}>
                    {(card) => (
                        <button
                            classList={{ active: props.openCard === card.kind }}
                            onClick={() => props.onToggleCard(card.kind)}
                        >
                            {card.label}
                        </button>
                    )}
                </For>
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
