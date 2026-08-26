import { onCleanup, onMount } from "solid-js";

// Wire up "close this popover when the user clicks outside it or presses Escape". Pass the popover
// element and the close callback. Listeners are attached on mount and torn down on unmount, so the
// hook is safe to use inside a component that only exists while the menu is open.
//
// `enabled` gates whether the handlers act. Transient popovers (mounted only while open) can leave
// it at its default. A popover whose trigger stays permanently mounted (an app-bar menu, a status
// item) MUST pass `() => open()` — otherwise its capture-phase Escape handler would stopPropagation
// on Escape app-wide even while closed, swallowing Escape for the palette, dialogs and rename
// fields.
export function useDismiss(
    getEl: () => HTMLElement | undefined,
    onClose: () => void,
    enabled: () => boolean = () => true,
) {
    onMount(() => {
        const onPointerDown = (e: PointerEvent) => {
            if (!enabled()) return;
            const el = getEl();
            if (el && !el.contains(e.target as Node)) onClose();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (!enabled()) return;
            if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
            }
        };
        // Defer attaching the pointer listener so the click that opened the menu doesn't
        // immediately close it.
        const id = setTimeout(() => {
            window.addEventListener("pointerdown", onPointerDown, true);
        }, 0);
        window.addEventListener("keydown", onKeyDown, true);
        onCleanup(() => {
            clearTimeout(id);
            window.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("keydown", onKeyDown, true);
        });
    });
}
