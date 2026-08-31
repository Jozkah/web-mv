import { createSignal, onCleanup } from "solid-js";
import { useWorkspace } from "../WorkspaceContext";

// A drag handle sitting on the 1px boundary between two side-by-side workspace groups. Dragging it
// resizes only the adjacent pair, preserving their combined width; every other group is untouched.
//
// The handle takes zero layout width - it is a flex item collapsed to 0 with an absolutely
// positioned hit area centred over the boundary, so adding a divider never pushes panes apart. It
// finds the two group <section>s it controls through the DOM (its previous/next element siblings),
// which stays correct as tabs move between groups or groups are added/removed.
//
// During a drag we write flex-grow straight onto the two group elements each animation frame - no
// store write, so the active views never remount and no poll restarts. The normalized weights are
// committed to workspace state once, on release, and Solid re-applies the identical values.

const MIN_GROUP_PX = 200; // smallest usable pane width
const KEY_STEP_PX = 24; // arrow-key nudge

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function growOf(el: HTMLElement): number {
    const g = parseFloat(getComputedStyle(el).flexGrow);
    return isFinite(g) && g > 0 ? g : 1;
}

export function ResizeDivider(props: {
    leftId: string;
    rightId: string;
    /** Dot arrangement. Vertical dots read as a horizontal (col-resize) divider - the only case
     *  today. Horizontal is here so stacked groups can reuse this component later. */
    orientation?: "vertical" | "horizontal";
}) {
    const ws = useWorkspace();
    const [dragging, setDragging] = createSignal(false);

    let hitEl: HTMLDivElement | undefined;
    let leftEl: HTMLElement | null = null;
    let rightEl: HTMLElement | null = null;
    let combinedWeight = 2; // sum of both groups' weights, constant across a drag
    let lastLeft = 1;
    let lastRight = 1;
    let raf = 0;
    let pendingX = 0;
    let active = false;

    const neighbours = (): [HTMLElement, HTMLElement] | null => {
        const root = hitEl?.parentElement;
        const l = root?.previousElementSibling as HTMLElement | null;
        const r = root?.nextElementSibling as HTMLElement | null;
        return l && r ? [l, r] : null;
    };

    // Position the boundary so it follows the pointer's x. Reading the neighbours' live rects each
    // frame keeps the maths correct even if the window (and so the container) is resized mid-drag.
    const apply = () => {
        raf = 0;
        if (!leftEl || !rightEl) return;
        const lRect = leftEl.getBoundingClientRect();
        const rRect = rightEl.getBoundingClientRect();
        const spanLeft = lRect.left;
        const combined = rRect.right - spanLeft;
        if (combined <= 0) return;
        const min = Math.min(MIN_GROUP_PX, combined / 2 - 1);
        const leftW = clamp(pendingX - spanLeft, min, combined - min);
        const rightW = combined - leftW;
        lastLeft = (combinedWeight * leftW) / combined;
        lastRight = (combinedWeight * rightW) / combined;
        leftEl.style.flexGrow = String(lastLeft);
        rightEl.style.flexGrow = String(lastRight);
    };

    const schedule = (x: number) => {
        pendingX = x;
        if (!raf) raf = requestAnimationFrame(apply);
    };

    const onMove = (e: PointerEvent) => schedule(e.clientX);
    const onUp = () => end(true);
    const onCancel = () => end(true);
    const onBlur = () => end(true);

    // Tear down a drag. `commit` writes the final weights to the store; unmount passes false since
    // the group elements (and possibly the groups) are going away.
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
        if (commit && leftEl && rightEl) {
            ws.resizeGroups(props.leftId, props.rightId, lastLeft, lastRight);
        }
        leftEl = rightEl = null;
    };

    const onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        const pair = neighbours();
        if (!pair) return;
        // Own this gesture: no text selection, no group focus/activation, no tab drag start.
        e.preventDefault();
        e.stopPropagation();
        [leftEl, rightEl] = pair;
        combinedWeight = growOf(leftEl) + growOf(rightEl);
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
        schedule(e.clientX);
    };

    // Keyboard resize for the focused divider: nudge the boundary a fixed step and commit at once.
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const pair = neighbours();
        if (!pair) return;
        e.preventDefault();
        const [l, r] = pair;
        const lRect = l.getBoundingClientRect();
        const rRect = r.getBoundingClientRect();
        const combined = rRect.right - lRect.left;
        if (combined <= 0) return;
        const cw = growOf(l) + growOf(r);
        const min = Math.min(MIN_GROUP_PX, combined / 2 - 1);
        const leftW = clamp(lRect.width + (e.key === "ArrowLeft" ? -KEY_STEP_PX : KEY_STEP_PX), min, combined - min);
        const rightW = combined - leftW;
        ws.resizeGroups(props.leftId, props.rightId, (cw * leftW) / combined, (cw * rightW) / combined);
    };

    onCleanup(() => end(false));

    return (
        <div class="ws-resizer" classList={{ dragging: dragging(), "ws-resizer--h": props.orientation === "horizontal" }}>
            <div
                ref={hitEl}
                class="ws-resizer-hit"
                role="separator"
                aria-orientation={props.orientation === "horizontal" ? "horizontal" : "vertical"}
                aria-label="Resize adjacent panels"
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
