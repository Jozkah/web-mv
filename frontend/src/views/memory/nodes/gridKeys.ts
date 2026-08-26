// Pure keyboard model for the node grid: key + modifiers + current focus state in, abstract
// action out. The component layer owns the DOM (scrolling, focus, guards for typing contexts);
// everything decidable without a DOM lives here so the navigation rules are unit-testable.

export interface GridKeyState {
    /** Number of rows currently shown (the filtered list). */
    rowCount: number;
    /** Position of the focused row within the filtered list, or null when nothing is focused. */
    focusIndex: number | null;
    /** Rows per viewport, for PageUp/PageDown. */
    pageSize: number;
}

export interface GridKeyModifiers {
    shift: boolean;
    ctrlOrMeta: boolean;
}

export type GridKeyAction =
    | { type: "focus"; index: number; extend: boolean }
    | { type: "selectAll" }
    | { type: "edit" }
    | { type: "rename" }
    | { type: "delete" }
    | { type: "menu" }
    | { type: "escape" };

const clamp = (i: number, count: number) => Math.max(0, Math.min(count - 1, i));

/** Map a key press to a grid action, or null when the grid doesn't handle it. */
export function gridKeyAction(key: string, mods: GridKeyModifiers, state: GridKeyState): GridKeyAction | null {
    const { rowCount, focusIndex, pageSize } = state;

    const move = (to: number): GridKeyAction | null =>
        rowCount === 0 ? null : { type: "focus", index: clamp(to, rowCount), extend: mods.shift };

    switch (key) {
        case "ArrowDown":
            return move(focusIndex === null ? 0 : focusIndex + 1);
        case "ArrowUp":
            return move(focusIndex === null ? rowCount - 1 : focusIndex - 1);
        case "Home":
            return move(0);
        case "End":
            return move(rowCount - 1);
        case "PageDown":
            return move((focusIndex ?? 0) + Math.max(1, pageSize));
        case "PageUp":
            return move((focusIndex ?? 0) - Math.max(1, pageSize));
        case "a":
        case "A":
            return mods.ctrlOrMeta ? { type: "selectAll" } : null;
        case "Enter":
            return focusIndex === null ? null : { type: "edit" };
        case "F2":
            return focusIndex === null ? null : { type: "rename" };
        case "Delete":
            return focusIndex === null ? null : { type: "delete" };
        case "ContextMenu":
            return focusIndex === null ? null : { type: "menu" };
        case "F10":
            return mods.shift && focusIndex !== null ? { type: "menu" } : null;
        case "Escape":
            return { type: "escape" };
        default:
            return null;
    }
}

/** Inclusive range of filtered-list positions between anchor and focus, in ascending order. */
export function rangeBetween(anchor: number, focus: number): number[] {
    const lo = Math.min(anchor, focus);
    const hi = Math.max(anchor, focus);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
}

/** True when a keydown originated inside a typing/interactive context the grid must not steal
 *  from: inputs, textareas, selects, contenteditable, or anything inside a dialog/window. */
export function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const el = target as HTMLElement;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return el.closest('[role="dialog"], .window, .modal') !== null;
}
