import { For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { onDismiss } from "../../../ui/dismiss";
import { NODE_TYPE_LIST, nodeType, type NodeTypeId } from "../nodes/types";

// The type cell: a badge button that opens a themed pop-over of the selectable primitives.
// Replaces the old native <select> (which ignored the site theme). An untyped node shows a
// dim "untyped" badge until a type is chosen. The pop-over renders through a Portal and is
// anchored to the button's viewport rect so the grid's overflow clipping can't cut it off
// (same trick as ModulePicker). Closes on pick or on a mousedown outside button + pop-over.
// The row's click handler is stopped so picking a type doesn't also re-select the row.

export function TypePicker(props: { typeId: NodeTypeId; onChange: (id: NodeTypeId) => void }) {
    const [open, setOpen] = createSignal(false);
    const [rect, setRect] = createSignal<DOMRect | null>(null);

    let buttonEl: HTMLButtonElement | undefined;
    let popEl: HTMLDivElement | undefined;

    const current = () => nodeType(props.typeId);

    const toggle = (e: MouseEvent) => {
        e.stopPropagation();
        if (open()) {
            setOpen(false);
            return;
        }
        if (buttonEl) setRect(buttonEl.getBoundingClientRect());
        setOpen(true);
    };

    onDismiss({
        isOpen: open,
        inside: (target) => !!buttonEl?.contains(target) || !!popEl?.contains(target),
        close: () => setOpen(false),
        escape: false,
    });

    const choose = (id: NodeTypeId, e: MouseEvent) => {
        e.stopPropagation();
        props.onChange(id);
        setOpen(false);
    };

    return (
        <div class="type-picker">
            <button
                ref={buttonEl}
                class={`type-badge type-${current().category} type-${current().id}`}
                classList={{ open: open() }}
                onClick={toggle}
            >
                {current().label}
            </button>

            <Show when={open() && rect()}>
                {(r) => (
                    <Portal>
                        <div
                            ref={popEl}
                            class="type-picker-pop panel"
                            style={{ top: `${r().bottom + 4}px`, left: `${r().left}px` }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div class="list type-options">
                                <For each={NODE_TYPE_LIST}>
                                    {(t) => (
                                        <div
                                            class={`row type-${t.category} type-${t.id}`}
                                            classList={{ selected: props.typeId === t.id }}
                                            onClick={(e) => choose(t.id, e)}
                                        >
                                            {t.label}
                                        </div>
                                    )}
                                </For>
                            </div>
                        </div>
                    </Portal>
                )}
            </Show>
        </div>
    );
}
