import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { useNavigation } from "./useNavigation";
import { GotoDialog } from "./GotoDialog";
import { Icon } from "./workspace/icons";
import "./nav.css";

// Top-bar navigation cluster: back / forward through the jump history, and a Goto (Ctrl+G) entry
// point. Owns the coordinator so both the buttons and the global shortcuts drive the same stack.
// Registered once (in the TopBar) - a single window-level key listener so Ctrl+G / Alt+Arrow work
// from anywhere, not just when a particular view has focus.

export function NavControls() {
    const nav = useNavigation();
    const [gotoOpen, setGotoOpen] = createSignal(false);

    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            if (mod && (e.key === "g" || e.key === "G")) {
                e.preventDefault();
                setGotoOpen(true);
            } else if (e.altKey && e.key === "ArrowLeft") {
                e.preventDefault();
                nav.back();
            } else if (e.altKey && e.key === "ArrowRight") {
                e.preventDefault();
                nav.forward();
            }
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    return (
        <>
            <div class="nav-controls">
                <button
                    class="nav-arrow"
                    disabled={!nav.canBack()}
                    onClick={() => nav.back()}
                    title="Back (Alt+Left)"
                >
                    ‹
                </button>
                <button
                    class="nav-arrow"
                    disabled={!nav.canForward()}
                    onClick={() => nav.forward()}
                    title="Forward (Alt+Right)"
                >
                    ›
                </button>
                <button onClick={() => setGotoOpen(true)} title="Go to address (Ctrl+G)">
                    <Icon name="static" size={15} />
                    Goto
                </button>
            </div>
            <Show when={gotoOpen()}>
                <GotoDialog
                    onClose={() => setGotoOpen(false)}
                    onGo={(kind, address, label) => nav.goto(kind, address, label)}
                />
            </Show>
        </>
    );
}
