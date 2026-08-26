import { For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { onDismiss } from "../../../ui/dismiss";
import {
    isBitsType,
    isRefType,
    isStringType,
    NODE_TYPE_LIST,
    supportsDisplayFormat,
    supportsEndian,
    type DisplayFormat,
    type Endian,
    type Node,
    type NodeTypeId,
} from "../nodes/types";
import type { CopyFormat } from "../nodes/copy";

// Right-click menu for the selected node(s), shaped like ReClass: a vertical list whose first
// entries fly a submenu out to the side. Top to bottom: Change Type (the primitives), Display
// format / Endianness / Length / Bit names (per-field presentation + span controls, shown when
// the lone selected node supports them), Lock/Unlock, Add Bytes and Insert Bytes (preset sizes
// + a custom amount), Create Class from Nodes; then a separator and Delete Node(s) + Copy
// (single selection only). Every action runs against the whole selection held in the store.
// Rendered through a Portal at the cursor so the grid's clipping can't cut it off; submenus
// flip to the left near the right edge. Closes on action, Escape, or a mousedown outside.

// Preset byte amounts for Add / Insert, matching ReClass's common sizes.
const BYTE_SIZES = [4, 8, 64, 256, 1024, 2048, 4096] as const;

// The Copy submenu, in display order. Each carries its label; availability (a live value/bytes
// need a snapshot, an address needs a class base) is passed in per-format so unusable rows dim.
const COPY_FORMATS: readonly { id: CopyFormat; label: string }[] = [
    { id: "address", label: "Address" },
    { id: "value", label: "Value" },
    { id: "bytes", label: "Bytes" },
    { id: "pointer-path", label: "Pointer path" },
    { id: "offsetof", label: "Offsetof" },
    { id: "reclass", label: "ReClass member" },
];

const DISPLAY_FORMATS: readonly { id: DisplayFormat; label: string }[] = [
    { id: "auto", label: "Auto (dec + hex)" },
    { id: "dec", label: "Decimal" },
    { id: "hex", label: "Hexadecimal" },
    { id: "bin", label: "Binary" },
];

export interface NodeMenuActions {
    onChangeType: (typeId: NodeTypeId) => void;
    onAddBytes: (bytes: number) => void;
    onInsertBytes: (bytes: number) => void;
    onCreateClass: () => void;
    onRepeat: (times: number) => void;
    onDelete: () => void;
    onCopy: (format: CopyFormat) => void;
    onSetDisplayFormat: (format: DisplayFormat) => void;
    onSetEndian: (endian: Endian) => void;
    onSetLength: (bytes: number) => void;
    onSetLocked: (locked: boolean) => void;
    onEditBitNames: () => void;
}

interface MenuProps extends NodeMenuActions {
    x: number;
    y: number;
    flip: boolean;
    count: number;
    /** The lone selected node, when exactly one is selected - drives per-field options. */
    node?: Node;
    /** True when every selected node is locked (drives the Lock/Unlock label). */
    allLocked: boolean;
    // Which copy formats have data to copy right now (single selection only).
    copyAvailable: Record<CopyFormat, boolean>;
    onClose: () => void;
}

// The Add / Insert submenu: preset sizes plus a free-text amount. `verb` labels both the items
// and the apply button ("Add" / "Insert"); `onPick` fires the action and closes the menu.
const REPEAT_COUNTS = [2, 4, 8, 16, 32, 64] as const;

function BytesSubmenu(props: { verb: string; onPick: (bytes: number) => void; presets?: readonly number[]; unit?: string }) {
    const [custom, setCustom] = createSignal("");
    const unit = () => props.unit ?? " bytes";

    const applyCustom = () => {
        const n = Number.parseInt(custom(), 10);
        if (Number.isFinite(n) && n > 0) props.onPick(n);
    };

    return (
        <div class="node-submenu">
            <For each={props.presets ?? BYTE_SIZES}>
                {(n) => (
                    <button class="node-submenu-item" onClick={() => props.onPick(n)}>
                        {props.verb} {n}{unit()}
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
    const node = () => props.node;
    const canFormat = () => {
        const n = node();
        return n !== undefined && supportsDisplayFormat(n.typeId);
    };
    const canEndian = () => {
        const n = node();
        return n !== undefined && supportsEndian(n.typeId);
    };
    const canLength = () => {
        const n = node();
        return n !== undefined && (isStringType(n.typeId) || isRefType(n.typeId));
    };
    const canBitNames = () => {
        const n = node();
        return n !== undefined && isBitsType(n.typeId);
    };

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

                <Show when={canFormat()}>
                    <div class="node-menu-item has-submenu">
                        Display format
                        <span class="submenu-arrow">▸</span>
                        <div class="node-submenu">
                            <For each={DISPLAY_FORMATS}>
                                {(f) => (
                                    <button
                                        class="node-submenu-item"
                                        classList={{ active: (node()?.displayFormat ?? "auto") === f.id }}
                                        onClick={() => run(() => props.onSetDisplayFormat(f.id))}
                                    >
                                        {f.label}
                                    </button>
                                )}
                            </For>
                        </div>
                    </div>
                </Show>

                <Show when={canEndian()}>
                    <div class="node-menu-item has-submenu">
                        Endianness
                        <span class="submenu-arrow">▸</span>
                        <div class="node-submenu">
                            <button
                                class="node-submenu-item"
                                classList={{ active: (node()?.endian ?? "le") === "le" }}
                                onClick={() => run(() => props.onSetEndian("le"))}
                            >
                                Little-endian
                            </button>
                            <button
                                class="node-submenu-item"
                                classList={{ active: node()?.endian === "be" }}
                                onClick={() => run(() => props.onSetEndian("be"))}
                            >
                                Big-endian
                            </button>
                        </div>
                    </div>
                </Show>

                <Show when={canLength()}>
                    <div class="node-menu-item has-submenu">
                        Set length
                        <span class="submenu-arrow">▸</span>
                        <BytesSubmenu verb="Length" presets={[8, 16, 32, 64, 128, 256]} onPick={(n) => run(() => props.onSetLength(n))} />
                    </div>
                </Show>

                <Show when={canBitNames()}>
                    <button class="node-menu-item" onClick={() => run(props.onEditBitNames)}>
                        Name bits…
                    </button>
                </Show>

                <button class="node-menu-item" onClick={() => run(() => props.onSetLocked(!props.allLocked))}>
                    {props.allLocked ? "Unlock" : "Lock"} {props.count > 1 ? `${props.count} fields` : "field"}
                </button>

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

                <div class="node-menu-item has-submenu">
                    Repeat (array)
                    <span class="submenu-arrow">▸</span>
                    <BytesSubmenu verb="×" unit="" presets={REPEAT_COUNTS} onPick={(n) => run(() => props.onRepeat(n))} />
                </div>

                <div class="node-menu-sep" />

                <Show when={props.count === 1}>
                    <div class="node-menu-item has-submenu">
                        Copy
                        <span class="submenu-arrow">▸</span>
                        <div class="node-submenu">
                            <For each={COPY_FORMATS}>
                                {(f) => (
                                    <button
                                        class="node-submenu-item"
                                        disabled={!props.copyAvailable[f.id]}
                                        onClick={() => run(() => props.onCopy(f.id))}
                                    >
                                        {f.label}
                                    </button>
                                )}
                            </For>
                        </div>
                    </div>
                </Show>

                <button class="node-menu-item danger" onClick={() => run(props.onDelete)}>
                    {deleteLabel()}
                </button>
            </div>
        </Portal>
    );
}
