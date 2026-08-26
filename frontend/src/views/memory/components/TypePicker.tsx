import { For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { onDismiss } from "../../../ui/dismiss";
import { NODE_TYPE_LIST, NODE_TYPES, nodeType, type Node, type NodeTypeId } from "../nodes/types";
import type { SetTypeOptions } from "../nodes/layout";
import { useDataTypes } from "../../datatypes/state/DataTypesContext";

// The type cell: a badge button that opens a themed pop-over of the selectable primitives plus
// the user-defined structs/enums from the dataTypes registry (picked by reference - the node
// captures the definition's current byte span so layout stays deterministic). An untyped node
// shows a dim "untyped" badge until a type is chosen. The pop-over renders through a Portal and
// is anchored to the button's viewport rect so the grid's overflow clipping can't cut it off
// (same trick as ModulePicker). Closes on pick or on a mousedown outside button + pop-over.
// The row's click handler is stopped so picking a type doesn't also re-select the row.

export function TypePicker(props: {
    node: Node;
    onChange: (id: NodeTypeId, opts?: SetTypeOptions) => void;
}) {
    const dt = useDataTypes();
    const [open, setOpen] = createSignal(false);
    const [rect, setRect] = createSignal<DOMRect | null>(null);

    let buttonEl: HTMLButtonElement | undefined;
    let popEl: HTMLDivElement | undefined;

    const current = () => nodeType(props.node.typeId);
    // A ref badge shows the referenced name (missing definitions flagged) instead of "enum"/"struct".
    const badgeLabel = () => {
        if (props.node.typeId === "enumref") {
            const known = props.node.refName && dt.enumByName(props.node.refName);
            return known ? props.node.refName! : `${props.node.refName ?? "?"}⚠`;
        }
        if (props.node.typeId === "structref") {
            const known = props.node.refName && dt.structByName(props.node.refName);
            return known ? props.node.refName! : `${props.node.refName ?? "?"}⚠`;
        }
        return current().label;
    };

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

    const choose = (id: NodeTypeId, e: MouseEvent, opts?: SetTypeOptions) => {
        e.stopPropagation();
        props.onChange(id, opts);
        setOpen(false);
    };

    return (
        <div class="type-picker">
            <button
                ref={buttonEl}
                class={`type-badge type-${current().category} type-${current().id}`}
                classList={{ open: open() }}
                onClick={toggle}
                title={props.node.refName ? `${current().label} ${props.node.refName}` : undefined}
            >
                {badgeLabel()}
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
                                            classList={{ selected: props.node.typeId === t.id }}
                                            onClick={(e) => choose(t.id, e)}
                                        >
                                            {t.label}
                                        </div>
                                    )}
                                </For>

                                <Show when={dt.structs.length > 0}>
                                    <div class="type-section-head">structs</div>
                                    <For each={dt.structs}>
                                        {(s) => {
                                            const size = () => Math.max(1, dt.sizeOf(s));
                                            return (
                                                <div
                                                    class="row type-ref type-structref"
                                                    classList={{ selected: props.node.typeId === "structref" && props.node.refName === s.name }}
                                                    title={`struct ${s.name} (${size()} bytes)`}
                                                    onClick={(e) => choose("structref", e, { refName: s.name, length: size() })}
                                                >
                                                    {s.name}
                                                </div>
                                            );
                                        }}
                                    </For>
                                </Show>

                                <Show when={dt.enums.length > 0}>
                                    <div class="type-section-head">enums</div>
                                    <For each={dt.enums}>
                                        {(en) => {
                                            const size = () => NODE_TYPES[en.underlying].size;
                                            return (
                                                <div
                                                    class="row type-ref type-enumref"
                                                    classList={{ selected: props.node.typeId === "enumref" && props.node.refName === en.name }}
                                                    title={`enum ${en.name} : ${en.underlying}`}
                                                    onClick={(e) => choose("enumref", e, { refName: en.name, length: size() })}
                                                >
                                                    {en.name}
                                                </div>
                                            );
                                        }}
                                    </For>
                                </Show>
                            </div>
                        </div>
                    </Portal>
                )}
            </Show>
        </div>
    );
}
