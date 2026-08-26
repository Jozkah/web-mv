import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { AppProvider } from "./AppContext";
import { WorkspaceProvider } from "./WorkspaceContext";
import { ShellProvider, useShell } from "./shell/ShellContext";
import { AppBar } from "./shell/AppBar";
import { ActivityRail } from "./shell/ActivityRail";
import { ContextualSidebar } from "./shell/ContextualSidebar";
import { StatusBar } from "./shell/StatusBar";
import { CommandPalette } from "./shell/CommandPalette";
import { WorkspaceView } from "./WorkspaceView";
import { GotoDialog } from "./GotoDialog";
import { useNavigation } from "./useNavigation";
import { useMemory } from "../views/memory/state/MemoryContext";
import { StaticProvider } from "../views/static/state/StaticContext";
import { MemoryProvider } from "../views/memory/state/MemoryContext";
import { StringsProvider } from "../views/strings/state/StringsContext";
import { DataTypesProvider } from "../views/datatypes/state/DataTypesContext";
import { SigMakerProvider } from "../views/static/sigmaker/SigMakerContext";
import { ScanCard } from "../scan/ScanCard";
import { Window } from "../ui/Window";
import "../ui/panels.css";
import "../ui/window.css";
import "./shell.css";
import "./nav.css";
import "../views/static/static.css";
import "../views/memory/memory.css";
import "../views/strings/strings.css";
import "../views/history/history.css";
import "../scan/scan.css";

// Composition root. The provider stack (Workspace → App → per-view state → SigMaker → Shell) is
// unchanged in order and behaviour; ShellProvider is added at the bottom to own the surrounding
// Signal Workbench chrome (activity rail, contextual sidebar, status bar, command palette). The
// data/state layers below it keep their exact semantics, so every existing behaviour is preserved.

export default function App() {
    return (
        <WorkspaceProvider>
            <AppProvider>
                <StaticProvider>
                    <MemoryProvider>
                        <StringsProvider>
                            <DataTypesProvider>
                                <SigMakerProvider>
                                    <ShellProvider>
                                        <Shell />
                                    </ShellProvider>
                                </SigMakerProvider>
                            </DataTypesProvider>
                        </StringsProvider>
                    </MemoryProvider>
                </StaticProvider>
            </AppProvider>
        </WorkspaceProvider>
    );
}

function Shell() {
    const shell = useShell();
    const nav = useNavigation();
    const memory = useMemory();

    // Persistent state for the Signature Scan floating window (z-order + pin survive close).
    const [sigScanPinned, setSigScanPinned] = createSignal(false);
    const [winZIndex, setWinZIndex] = createSignal(100);

    // Global undo/redo for the memory workspace: Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo. Ignored
    // while typing into a field so it never clobbers native text editing (Cmd for macOS parity).
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
            if (!(e.ctrlKey || e.metaKey)) return;
            const k = e.key.toLowerCase();
            if (k === "z" && !e.shiftKey) {
                e.preventDefault();
                memory.undo();
            } else if ((k === "z" && e.shiftKey) || k === "y") {
                e.preventDefault();
                memory.redo();
            }
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    return (
        <div class="wb" classList={{ zen: shell.zen() }}>
            <AppBar />

            <div class="wb-body">
                <Show when={!shell.zen()}>
                    <ActivityRail />
                </Show>
                <Show when={!shell.zen() && shell.sidebarOpen()}>
                    <ContextualSidebar />
                </Show>

                <div class="wb-center">
                    <WorkspaceView />

                    <Window
                        id="sigscan-window"
                        title="Signature scan"
                        isOpen={shell.sigScanOpen()}
                        onClose={() => shell.setSigScanOpen(false)}
                        isPinned={sigScanPinned()}
                        onTogglePin={() => setSigScanPinned((p) => !p)}
                        initialPos={{ x: 120, y: 84 }}
                        initialSize={{ width: 500, height: 540 }}
                        minWidth={380}
                        minHeight={260}
                        zIndex={winZIndex()}
                        onFocus={() => setWinZIndex((z) => Math.max(z, 101))}
                    >
                        <ScanCard kind="sig" onClose={() => shell.setSigScanOpen(false)} />
                    </Window>
                </div>
            </div>

            <Show when={!shell.zen()}>
                <StatusBar />
            </Show>

            <Show when={shell.paletteOpen()}>
                <CommandPalette />
            </Show>
            <Show when={shell.gotoOpen()}>
                <GotoDialog
                    onClose={() => shell.closeGoto()}
                    onGo={(kind, address, label) => nav.goto(kind, address, label)}
                />
            </Show>
        </div>
    );
}
