import { For, Show, createEffect, createMemo, createSignal, type Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { parseHex, toHex } from "../../../state/address";
import { createListVirtualizer } from "../../../ui/virtualList";
import { bytePairs, readString } from "../nodes/format";
import { offsets } from "../nodes/layout";
import { isStringType, nodeByteSize, nodeNumericValue, nodeType, type Node } from "../nodes/types";
import { buildCopyText, type CopyContext, type CopyFormat } from "../nodes/copy";
import { useMemory } from "../state/MemoryContext";
import type { MemorySnapshot } from "../state/useMemorySnapshot";
import { NodeContextMenu } from "./NodeContextMenu";
import { NodeRow } from "./NodeRow";
import { PointerExpansion } from "./PointerExpansion";

const ROW_HEIGHT = 30;

// Width reserved for the menu plus a flown-out submenu, so we can flip submenus to the left when
// the cursor is too close to the right edge to fit them.
const MENU_REACH = 460;

interface MenuState {
    x: number;
    y: number;
    flip: boolean;
}

// The virtualized node table: a fixed header plus the rows of the active class. Offsets are
// derived from the node list; live values come from the snapshot. Rename state is held here
// (one node at a time); structural edits delegate to the memory store by node index.

export function NodeGrid(props: {
    nodes: Accessor<Node[]>;
    baseAddress: Accessor<string>;
    snapshot: Accessor<MemorySnapshot | null | undefined>;
}) {
    const memory = useMemory();
    const offs = createMemo(() => offsets(props.nodes()));

    const [editingId, setEditingId] = createSignal<string | null>(null);
    const [menu, setMenu] = createSignal<MenuState | null>(null);
    const { setRef, virtualizer } = createListVirtualizer(() => props.nodes().length, ROW_HEIGHT);

    // Right-clicking a node outside the current selection first selects just that node, so the
    // menu always acts on something sensible; right-clicking inside the selection keeps it.
    const openMenu = (e: MouseEvent, nodeId: string) => {
        e.preventDefault();
        if (!memory.isSelected(nodeId)) memory.selectNode(nodeId);
        // Keep the menu on-screen when right-clicking near the right/bottom edge.
        const x = Math.min(e.clientX, window.innerWidth - 240);
        const y = Math.min(e.clientY, window.innerHeight - 320);
        setMenu({ x, y, flip: e.clientX > window.innerWidth - MENU_REACH });
    };

    // Live target of a pointer node (for inline expansion), or undefined when it's null / unread.
    const pointerTarget = (nodeId: string): string | undefined => {
        const p = props.snapshot()?.pointers.get(nodeId);
        return p && p.target !== "0x0" ? p.target : undefined;
    };

    // Build the "Copy as" context for the lone selected node: its layout (always available) plus
    // its live value/bytes when a snapshot is in bounds. undefined unless exactly one is selected.
    const copyContext = (): CopyContext | undefined => {
        const ids = memory.selectedNodeIds;
        if (ids.length !== 1) return undefined;
        const cls = memory.activeClass();
        if (!cls) return undefined;
        const i = cls.nodes.findIndex((n) => n.id === ids[0]);
        if (i < 0) return undefined;
        const node = cls.nodes[i];
        const offset = offsets(cls.nodes)[i];
        const size = nodeByteSize(node);
        const address = cls.address ? toHex(parseHex(cls.address) + BigInt(offset)) : "";

        let value: string | undefined;
        let bytes: string | undefined;
        const snap = props.snapshot();
        if (snap && offset + size <= snap.view.byteLength) {
            bytes = bytePairs(snap.view, offset, size);
            value = isStringType(node.typeId)
                ? readString(snap.view, offset, size, node.typeId === "wstring")
                : nodeType(node.typeId).decode(snap.view, offset);
        }
        return { className: cls.name, node, offset, byteSize: size, address, baseAddress: cls.address, value, bytes };
    };

    // Which copy formats currently have data - drives the submenu's disabled state.
    const copyAvailable = (): Record<CopyFormat, boolean> => {
        const ctx = copyContext();
        const has = (f: CopyFormat) => (ctx ? buildCopyText(f, ctx) !== undefined : false);
        return {
            address: has("address"),
            value: has("value"),
            bytes: has("bytes"),
            "pointer-path": has("pointer-path"),
            offsetof: has("offsetof"),
            reclass: has("reclass"),
        };
    };

    const doCopy = (format: CopyFormat) => {
        const ctx = copyContext();
        if (!ctx) return;
        const text = buildCopyText(format, ctx);
        if (text) void navigator.clipboard?.writeText(text);
    };

    // Per-node value history for the sparkline. Each poll appends every numeric node's current
    // value (capped to a short window); non-numeric nodes are skipped. Keyed by node id so it
    // survives reordering; stale ids from deleted nodes simply stop updating.
    const [history, setHistory] = createStore<Record<string, number[]>>({});
    createEffect(() => {
        const snap = props.snapshot();
        if (!snap) return;
        const nodes = props.nodes();
        const o = offsets(nodes);
        setHistory(
            produce((h) => {
                for (let i = 0; i < nodes.length; i++) {
                    const v = nodeNumericValue(snap.view, o[i], nodes[i].typeId);
                    if (v === undefined) continue;
                    const arr = h[nodes[i].id] ?? (h[nodes[i].id] = []);
                    arr.push(v);
                    if (arr.length > 48) arr.shift();
                }
            }),
        );
    });

    return (
        <div class="node-grid">
            <div class="node-head">
                <span class="col-offset">offset</span>
                <span class="col-address">address</span>
                <span class="col-hex">bytes</span>
                <span class="col-name">name</span>
                <span class="col-type">type</span>
                <span class="col-value">value</span>
                <span class="col-actions" />
            </div>

            <div ref={setRef} class="list">
                <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
                    <For each={virtualizer.getVirtualItems()}>
                        {(item) => {
                            // A switch to a class with fewer nodes can leave the virtualizer holding
                            // items indexed past the new (shorter) node list for a tick before it
                            // recomputes. Guard on the node existing so a stale item renders nothing
                            // instead of feeding undefined into NodeRow's offset/decode math (which
                            // threw "Cannot convert undefined to a BigInt" and wedged the whole switch).
                            const node = () => props.nodes()[item.index];
                            return (
                                <Show when={node()}>
                                    {(n) => {
                                        // A pointer row's inline expansion grows the host past one row, so the
                                        // host is measured (data-index + measureElement) instead of hard-set to
                                        // the row height - the virtualizer then reserves the real height and the
                                        // rows below shift down to make room. The base row keeps its fixed height.
                                        const expanded = () => memory.isExpanded(n().id);
                                        const target = () => pointerTarget(n().id);
                                        return (
                                            <div
                                                class="node-row-host"
                                                data-index={item.index}
                                                ref={(el) => virtualizer.measureElement(el)}
                                                style={{
                                                    position: "absolute",
                                                    top: 0,
                                                    left: 0,
                                                    width: "100%",
                                                    transform: `translateY(${item.start}px)`,
                                                }}
                                            >
                                                <NodeRow
                                                    node={n()}
                                                    offset={offs()[item.index]}
                                                    baseAddress={props.baseAddress()}
                                                    snapshot={props.snapshot}
                                                    history={history[n().id]}
                                                    selected={memory.isSelected(n().id)}
                                                    editing={editingId() === n().id}
                                                    expanded={expanded()}
                                                    onToggleExpand={() => memory.toggleExpanded(n().id)}
                                                    onSelect={(e) =>
                                                        e.ctrlKey || e.metaKey
                                                            ? memory.toggleNode(n().id)
                                                            : memory.selectNode(n().id)
                                                    }
                                                    onChangeType={(typeId) => memory.setNodeType(item.index, typeId)}
                                                    onStartRename={() => setEditingId(n().id)}
                                                    onCommitRename={(name) => {
                                                        memory.renameNode(item.index, name);
                                                        setEditingId(null);
                                                    }}
                                                    onCancelRename={() => setEditingId(null)}
                                                    onContextMenu={(e) => openMenu(e, n().id)}
                                                    onDelete={() => memory.deleteNode(item.index)}
                                                    onFollow={(target, name) => memory.addClassAt(target, name)}
                                                />
                                                <Show when={expanded() && target()}>
                                                    {(addr) => (
                                                        <PointerExpansion address={addr()} path={n().id} depth={1} />
                                                    )}
                                                </Show>
                                            </div>
                                        );
                                    }}
                                </Show>
                            );
                        }}
                    </For>
                </div>
            </div>

            <Show when={menu()}>
                {(m) => (
                    <NodeContextMenu
                        x={m().x}
                        y={m().y}
                        flip={m().flip}
                        count={memory.selectedNodeIds.length}
                        copyAvailable={copyAvailable()}
                        onChangeType={(typeId) => memory.setSelectedType(typeId)}
                        onAddBytes={(bytes) => memory.addBytes(bytes)}
                        onInsertBytes={(bytes) => memory.insertBytesAboveSelection(bytes)}
                        onCreateClass={() => memory.createClassFromSelection()}
                        onDelete={() => memory.deleteSelected()}
                        onRepeat={(n) => memory.repeatSelection(n)}
                        onCopy={doCopy}
                        onClose={() => setMenu(null)}
                    />
                )}
            </Show>
        </div>
    );
}
