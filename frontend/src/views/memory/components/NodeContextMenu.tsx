import { For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { onDismiss } from "../../../ui/dismiss";
import { NODE_TYPE_LIST, type NodeTypeId } from "../nodes/types";

// Right-click menu for the selected node(s), shaped like ReClass: a vertical list whose first
// entries fly a submenu out to the side. Top to bottom: Change Type (the primitives), Add Bytes
// and Insert Bytes (preset sizes + a custom amount), Create Class from Nodes; then a separator
// and Delete Node(s) + Copy Address (single selection only). Every action runs against the whole
// selection held in the store, so the menu only needs the selected count and (for Copy Address)
// the lone node's address. Rendered through a Portal at the cursor so the grid's clipping can't
// cut it off; submenus flip to the left near the right edge. Closes on action, Escape, or a
// mousedown outside (same pattern as ModulePicker).

// Preset byte amounts for Add / Insert, matching ReClass's common sizes.
const BYTE_SIZES = [4, 8, 64, 256, 1024, 2048, 4096] as const;

export interface NodeMenuActions {
    onChangeType: (typeId: NodeTypeId) => void;
    onAddBytes: (bytes: number) => void;
    onInsertBytes: (bytes: number) => void;
    onCreateClass: () => void;
    onDelete: () => void;
    onCopyAddress: () => void;
}

interface MenuProps extends NodeMenuActions {
    x: number;
    y: number;
    flip: boolean;
    count: number;
    address: string | undefined;
    onClose: () => void;
}

// The Add / Insert submenu: preset sizes plus a free-text amount. `verb` labels both the items
// and the apply button ("Add" / "Insert"); `onPick` fires the action and closes the menu.
function BytesSubmenu(props: { verb: string; onPick: (bytes: number) => void }) {
    const [custom, setCustom] = createSignal("");

    const applyCustom = () => {
        const n = Number.parseInt(custom(), 10);
        if (Number.isFinite(n) && n > 0) props.onPick(n);
    };

    return (
        <div class="node-submenu">
            <For each={BYTE_SIZES}>
                {(n) => (
                    <button class="node-submenu-item" onClick={() => props.onPick(n)}>
                        {props.verb} {n} bytes
                    </button>
                )}
            </For>
            <div class="node-submenu-custom">
                <input
                    class="bytes-input"
                    type="text"
                    placeholder="bytes"
                    value={custom()}
                    onClick={(e) => e.stopPropagation()}
                    onInput={(e) => setCustom(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            applyCustom();
                        }
                    }}
                />
                <button class="bytes-go" onClick={applyCustom}>
                    {props.verb}…
                </button>
            </div>
        </div>
    );
}

export function NodeContextMenu(props: MenuProps) {
    let menuEl: HTMLDivElement | undefined;

    onDismiss({
        isOpen: () => true,
        inside: (target) => !!menuEl?.contains(target),
        close: () => props.onClose(),
    });

    const run = (fn: () => void) => {
        fn();
        props.onClose();
    };

    const deleteLabel = () => (props.count > 1 ? `Delete ${props.count} nodes` : "Delete node");

    return (
        <Portal>
            <div
                ref={menuEl}
                class="node-menu panel"
                classList={{ flip: props.flip }}
                style={{ top: `${props.y}px`, left: `${props.x}px` }}
                onClick={(e) => e.stopPropagation()}
            >
                <div class="node-menu-item has-submenu">
                    Change type
                    <span class="submenu-arrow">▸</span>
                    <div class="node-submenu type-options">
                        <For each={NODE_TYPE_LIST}>
                            {(t) => (
                                <div class={`row type-${t.category} type-${t.id}`} onClick={() => run(() => props.onChangeType(t.id))}>
                                    {t.label}
                                </div>
                            )}
                        </For>
                    </div>
                </div>

                <div class="node-menu-item has-submenu">
                    Add bytes
                    <span class="submenu-arrow">▸</span>
                    <BytesSubmenu verb="Add" onPick={(n) => run(() => props.onAddBytes(n))} />
                </div>

                <div class="node-menu-item has-submenu">
                    Insert bytes
                    <span class="submenu-arrow">▸</span>
                    <BytesSubmenu verb="Insert" onPick={(n) => run(() => props.onInsertBytes(n))} />
                </div>

                <button class="node-menu-item" onClick={() => run(props.onCreateClass)}>
                    Create class from nodes
                </button>

                <div class="node-menu-sep" />

                <Show when={props.count === 1}>
                    <button
                        class="node-menu-item"
                        disabled={props.address === undefined}
                        onClick={() => run(props.onCopyAddress)}
                    >
                        Copy address
                    </button>
                </Show>

                <button class="node-menu-item danger" onClick={() => run(props.onDelete)}>
                    {deleteLabel()}
                </button>
            </div>
        </Portal>
    );
}
