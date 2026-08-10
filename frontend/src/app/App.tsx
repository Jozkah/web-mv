import { Match, Show, Switch, createSignal } from "solid-js";
import { AppProvider, useApp } from "./AppContext";
import { TopBar } from "./TopBar";
import { StaticProvider } from "../views/static/state/StaticContext";
import { StaticView } from "../views/static/StaticView";
import { MemoryProvider } from "../views/memory/state/MemoryContext";
import { MemoryView } from "../views/memory/MemoryView";
import { StringsProvider } from "../views/strings/state/StringsContext";
import { StringsView } from "../views/strings/StringsView";
import { ScanCard, type ScanKind } from "../scan/ScanCard";
import "../ui/panels.css";
import "./shell.css";
import "../views/static/static.css";
import "../views/memory/memory.css";
import "../views/strings/strings.css";
import "../scan/scan.css";

// Composition root: shared app state wraps the per-view state providers, which wrap the
// shell. The view providers sit above the switch so each view's state (the static caches,
// the memory class definitions) survives a tab change while only the active view's DOM -
// and its polling - is mounted.

export default function App() {
    return (
        <AppProvider>
            <StaticProvider>
                <MemoryProvider>
                    <StringsProvider>
                        <Shell />
                    </StringsProvider>
                </MemoryProvider>
            </StaticProvider>
        </AppProvider>
    );
}

function Shell() {
    const { activeView } = useApp();

    // Which scan card (if any) is popped down from the top bar - at most one at a time.
    // Lives here (not in a context) because only the bar and this shell need it.
    const [openCard, setOpenCard] = createSignal<ScanKind | null>(null);
    const toggleCard = (kind: ScanKind) => setOpenCard((cur) => (cur === kind ? null : kind));

    return (
        <main class="app">
            <TopBar openCard={openCard()} onToggleCard={toggleCard} />
            <div class="view-host">
                <div class="view-content">
                    <Switch>
                        <Match when={activeView() === "memory"}>
                            <MemoryView />
                        </Match>
                        <Match when={activeView() === "static"}>
                            <StaticView />
                        </Match>
                        <Match when={activeView() === "strings"}>
                            <StringsView />
                        </Match>
                    </Switch>
                </div>

                <Show when={openCard()}>
                    {(kind) => (
                        <>
                            <div class="scan-backdrop" onClick={() => setOpenCard(null)} />
                            <div class="scan-popdown">
                                <ScanCard kind={kind()} onClose={() => setOpenCard(null)} />
                            </div>
                        </>
                    )}
                </Show>
            </div>
        </main>
    );
}
