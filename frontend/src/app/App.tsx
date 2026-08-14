import { createSignal, onCleanup, onMount } from "solid-js";
import { AppProvider } from "./AppContext";
import { WorkspaceProvider } from "./WorkspaceContext";
import { TopBar } from "./TopBar";
import { TargetTabBar } from "./TargetTabBar";
import { WorkspaceView } from "./WorkspaceView";
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
import "../views/static/static.css";
import "../views/memory/memory.css";
import "../views/strings/strings.css";
import "../views/history/history.css";
import "../scan/scan.css";

// Composition root: Workspace state wraps shared app state and per-view state providers.
// WorkspaceView renders multi-tabs and split panels, with each view's state preserved.
// Floating windows (Signature Scan, etc.) remain mounted persistently so inner signals and results stay intact.

export default function App() {
    return (
        <WorkspaceProvider>
            <AppProvider>
                <StaticProvider>
                    <MemoryProvider>
                        <StringsProvider>
                            <DataTypesProvider>
                                <SigMakerProvider>
                                    <Shell />
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
    // Persistent state for Signature Scan floating window
    const [sigScanOpen, setSigScanOpen] = createSignal(false);
    const [sigScanPinned, setSigScanPinned] = createSignal(false);
    const [winZIndex, setWinZIndex] = createSignal(100);

    const toggleSigScan = () => {
        setSigScanOpen((cur) => !cur);
        if (!sigScanOpen()) {
            setWinZIndex((z) => z + 1);
        }
    };

    // Global undo/redo for the memory workspace: Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo. Ignored
    // while typing into a field so it never clobbers native text editing (Cmd for macOS parity).
    const memory = useMemory();
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
        <main class="app">
            <TopBar sigScanOpen={sigScanOpen()} onToggleSigScan={toggleSigScan} />
            <TargetTabBar />
            <div class="view-host">
                <div class="view-content">
                    <WorkspaceView />
                </div>

                <Window
                    id="sigscan-window"
                    title="🎯 Signature scan"
                    isOpen={sigScanOpen()}
                    onClose={() => setSigScanOpen(false)}
                    isPinned={sigScanPinned()}
                    onTogglePin={() => setSigScanPinned((p) => !p)}
                    initialPos={{ x: 100, y: 70 }}
                    initialSize={{ width: 500, height: 540 }}
                    minWidth={380}
                    minHeight={260}
                    zIndex={winZIndex()}
                    onFocus={() => setWinZIndex((z) => Math.max(z, 101))}
                >
                    <ScanCard kind="sig" onClose={() => setSigScanOpen(false)} />
                </Window>
            </div>
        </main>
    );
}
