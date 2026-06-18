import { For, Show, createMemo, createSignal, type Accessor } from "solid-js";
import { parseHex, toHex } from "../../../state/address";
import { createListVirtualizer } from "../../../ui/virtualList";
import { offsets } from "../nodes/layout";
import { type Node } from "../nodes/types";
import { useMemory } from "../state/MemoryContext";
import type { MemorySnapshot } from "../state/useMemorySnapshot";
import { NodeContextMenu } from "./NodeContextMenu";
import { NodeRow } from "./NodeRow";

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

    // Absolute address of the lone selected node, for "Copy Address" (single selection only).
    // undefined when the count isn't exactly one or the class has no base address yet.
    const singleAddress = (): string | undefined => {
        const ids = memory.selectedNodeIds;
        if (ids.length !== 1) return undefined;
        const cls = memory.activeClass();
        if (!cls || !cls.address) return undefined;
        const nodes = cls.nodes;
        const i = nodes.findIndex((n) => n.id === ids[0]);
        if (i < 0) return undefined;
        return toHex(parseHex(cls.address) + BigInt(offsets(nodes)[i]));
    };

    const copyAddress = () => {
        const addr = singleAddress();
        if (addr) void navigator.clipboard?.writeText(addr);
    };

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
                                    {(n) => (
                                        <div
                                            class="node-row-host"
                                            style={{
                                                position: "absolute",
                                                top: 0,
                                                left: 0,
                                                width: "100%",
                                                height: `${item.size}px`,
                                                transform: `translateY(${item.start}px)`,
                                            }}
                                        >
                                            <NodeRow
                                                node={n()}
                                                offset={offs()[item.index]}
                                                baseAddress={props.baseAddress()}
                                                snapshot={props.snapshot}
                                                selected={memory.isSelected(n().id)}
                                                editing={editingId() === n().id}
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
                                        </div>
                                    )}
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
                        address={singleAddress()}
                        onChangeType={(typeId) => memory.setSelectedType(typeId)}
                        onAddBytes={(bytes) => memory.addBytes(bytes)}
                        onInsertBytes={(bytes) => memory.insertBytesAboveSelection(bytes)}
                        onCreateClass={() => memory.createClassFromSelection()}
                        onDelete={() => memory.deleteSelected()}
                        onCopyAddress={copyAddress}
                        onClose={() => setMenu(null)}
                    />
                )}
            </Show>
        </div>
    );
}
