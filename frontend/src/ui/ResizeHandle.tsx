import { onCleanup } from "solid-js";

// An accessible vertical splitter for resizing a pane to its RIGHT. It reports pixel deltas as the
// user drags; the parent clamps + persists via ui/resize. Keyboard-resizable (arrow keys, Shift for
// a larger step), double-click resets, and it carries proper separator ARIA. The dotted grip matches
// the workspace divider so resize affordances read consistently across the app.

export function ResizeHandle(props: {
    // Current pane width, for aria-valuenow; and its min/max for the ARIA range.
    value: number;
    min: number;
    max: number;
    // Called with the new absolute pane width (from drag or keyboard).
    onSet: (px: number) => void;
    onReset: () => void;
    label: string;
}) {
    let startX = 0;
    let startVal = 0;

    const onPointerDown = (e: PointerEvent) => {
        e.preventDefault();
        startX = e.clientX;
        startVal = props.value;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        // The pane sits on the RIGHT, so dragging left (clientX decreases) grows it.
        const move = (ev: PointerEvent) => props.onSet(startVal + (startX - ev.clientX));
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        onCleanup(up);
    };

    const onKeyDown = (e: KeyboardEvent) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft") { e.preventDefault(); props.onSet(props.value + step); } // grow (pane is on the right)
        else if (e.key === "ArrowRight") { e.preventDefault(); props.onSet(props.value - step); }
        else if (e.key === "Home") { e.preventDefault(); props.onReset(); }
    };

    return (
        <div
            class="resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={props.label}
            aria-valuenow={props.value}
            aria-valuemin={props.min}
            aria-valuemax={props.max}
            tabindex="0"
            onPointerDown={onPointerDown}
            onDblClick={() => props.onReset()}
            onKeyDown={onKeyDown}
        >
            <span class="resize-grip" aria-hidden="true" />
        </div>
    );
}
