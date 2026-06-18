import { createSignal, onMount, type Accessor } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";

// Shared setup for a vertically virtualized list. Returns a `setRef` to attach to the
// scroll container and the virtualizer itself; the caller renders the spacer + absolutely
// positioned rows from `virtualizer.getTotalSize()` / `getVirtualItems()`.
//
// Load-bearing detail: the scroll element is handed to the virtualizer only after the
// first paint (rAF). Binding it during render/onMount measures the not-yet-laid-out flex
// height as 0 and the virtualizer never recovers - getVirtualItems stays empty while
// getTotalSize looks fine. The rAF guarantees a laid-out, attached element on first
// measurement. Reuse this for any virtualized list (the function list and the memory node
// grid both go through it).

export function createListVirtualizer(count: Accessor<number>, rowHeight: number, overscan = 16) {
    let ref: HTMLDivElement | undefined;
    const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
    onMount(() => requestAnimationFrame(() => setScrollEl(ref)));

    const virtualizer = createVirtualizer({
        get count() {
            return count();
        },
        getScrollElement: () => scrollEl() ?? null,
        estimateSize: () => rowHeight,
        overscan,
    });

    return {
        setRef: (el: HTMLDivElement) => (ref = el),
        virtualizer,
    };
}
