import { createSignal, onCleanup } from "solid-js";

// A vertical drag handle that resizes the pane immediately before it (its previous element
// sibling) inside a horizontal flex row. Unlike the workspace group divider - which splits a shared
// width between two proportional siblings - this sets one pane's explicit pixel width and lets the
// panes after it reflow to fill. Used for the static-analysis view's rail | functions | disasm seams.
//
// Zero layout width: it is a collapsed flex item with an absolutely-centred hit area, so dropping
// one into a `gap`-spaced row does not visibly spread the panes apart. It reuses the workspace
// divider's grip styling (.ws-resizer*) for a consistent look; .sv-resizer only fixes up the gap.

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const KEY_STEP_PX = 24;

export function PaneResizer(props: {
    min: number;
    max: number;
    /** Live width while dragging - update layout, do not persist. */
    onInput: (w: number) => void;
    /** Final width on release - update layout and persist. */
    onCommit: (w: number) => void;
}) {
    const [dragging, setDragging] = createSignal(false);

    let hitEl: HTMLDivElement | undefined;
    let target: HTMLElement | null = null;
    let startX = 0;
    let startW = 0;
    let lastW = 0;
    let raf = 0;
    let pendingX = 0;
    let active = false;

    const targetPane = () => (hitEl?.parentElement?.previousElementSibling as HTMLElement | null) ?? null;

    const apply = () => {
        raf = 0;
        lastW = clamp(startW + (pendingX - startX), props.min, props.max);
        props.onInput(lastW);
    };
    const schedule = (x: number) => {
        pendingX = x;
        if (!raf) raf = requestAnimationFrame(apply);
    };

    const onMove = (e: PointerEvent) => schedule(e.clientX);
    const onUp = () => end(true);
    const onCancel = () => end(true);
    const onBlur = () => end(true);

    const end = (commit: boolean) => {
        if (!active) return;
        active = false;
        setDragging(false);
        if (raf) {
            cancelAnimationFrame(raf);
            raf = 0;
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onBlur);
        document.body.classList.remove("ws-resizing");
        if (commit) props.onCommit(lastW);
        target = null;
    };

    const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        target = targetPane();
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startW = target.getBoundingClientRect().width;
        lastW = startW;
        active = true;
        setDragging(true);
        document.body.classList.add("ws-resizing");
        try {
            hitEl?.setPointerCapture(e.pointerId);
        } catch {
            /* capture is best-effort */
        }
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("blur", onBlur);
    };

    const onKey = (e: KeyboardEvent) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const t = targetPane();
        if (!t) return;
        e.preventDefault();
        const w = clamp(
            t.getBoundingClientRect().width + (e.key === "ArrowLeft" ? -KEY_STEP_PX : KEY_STEP_PX),
            props.min,
            props.max,
        );
        props.onInput(w);
        props.onCommit(w);
    };

    onCleanup(() => end(false));

    return (
        <div class="ws-resizer sv-resizer" classList={{ dragging: dragging() }}>
            <div
                ref={hitEl}
                class="ws-resizer-hit"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panel"
                tabindex="0"
                onPointerDown={onDown}
                onLostPointerCapture={() => end(true)}
                onKeyDown={onKey}
            >
                <div class="ws-resizer-grip" aria-hidden="true">
                    <span class="ws-resizer-dot" />
                    <span class="ws-resizer-dot" />
                    <span class="ws-resizer-dot" />
                    <span class="ws-resizer-dot" />
                    <span class="ws-resizer-dot" />
                </div>
            </div>
        </div>
    );
}
