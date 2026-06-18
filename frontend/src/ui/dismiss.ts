import { createEffect, onCleanup } from "solid-js";

// Close a transient layer (a pop-over or a context menu) when the user mouses down outside it or
// presses Escape. The pop-over pickers and the node menu all need the same document-level listener
// dance, so it lives here once. `isOpen` gates the listeners; pass () => true for a layer that is
// always mounted while open (the node context menu). `inside` returns true for the elements that
// should NOT dismiss (the trigger button, the pop body), so a click on those is ignored. Set
// `escape: false` for layers that handle Escape themselves (the searchable pickers close their own
// input on Escape instead).

export interface DismissOptions {
    isOpen: () => boolean;
    inside: (target: Node) => boolean;
    close: () => void;
    escape?: boolean;
}

export function onDismiss(opts: DismissOptions): void {
    createEffect(() => {
        if (!opts.isOpen()) return;

        const onDown = (e: MouseEvent) => {
            if (!opts.inside(e.target as Node)) opts.close();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") opts.close();
        };

        document.addEventListener("mousedown", onDown);
        if (opts.escape !== false) document.addEventListener("keydown", onKey);
        onCleanup(() => {
            document.removeEventListener("mousedown", onDown);
            if (opts.escape !== false) document.removeEventListener("keydown", onKey);
        });
    });
}
