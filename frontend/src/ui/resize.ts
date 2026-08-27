import { createSignal, type Accessor } from "solid-js";
import { load, save } from "../state/persist";

// Pure resize math + a persisted-width hook for resizable panes. Kept pure so the clamping is
// unit-testable and the same rules apply to pointer drag, keyboard resize, and double-click reset.

export function clampWidth(px: number, min: number, max: number): number {
    if (!Number.isFinite(px)) return min;
    return Math.min(max, Math.max(min, Math.round(px)));
}

// Keyboard step (arrow keys nudge a pane; Shift for a larger step).
export function keyboardResize(current: number, key: string, min: number, max: number, step = 16, bigStep = 64): number | undefined {
    const s = key.includes("Shift") ? bigStep : step; // callers may pass "Shift+ArrowLeft"
    const base = key.replace("Shift+", "");
    if (base === "ArrowLeft") return clampWidth(current - s, min, max);
    if (base === "ArrowRight") return clampWidth(current + s, min, max);
    return undefined;
}

// A width signal that persists to localStorage under `key`, clamped to [min, max]. Returns the
// accessor, a clamped setter, and a reset-to-default.
export function usePersistedWidth(key: string, initial: number, min: number, max: number) {
    const saved = load<number>(`ax.width.${key}`, 1);
    const [width, setWidthRaw] = createSignal(clampWidth(typeof saved === "number" ? saved : initial, min, max));
    const set = (px: number) => {
        const w = clampWidth(px, min, max);
        setWidthRaw(w);
        save(`ax.width.${key}`, 1, w);
    };
    const reset = () => set(initial);
    return { width: width as Accessor<number>, set, reset, min, max };
}
