import { For, Show, createMemo, type Accessor } from "solid-js";
import { parseHex } from "../../../state/address";
import { asciiPreview, bytePairs, diffSegments, hexPairs, readString } from "../nodes/format";
import { isStringType, nodeByteSize, nodeType, type Node, type NodeTypeId } from "../nodes/types";
import type { MemorySnapshot } from "../state/useMemorySnapshot";
import { RenameInput } from "../../../ui/RenameInput";
import { TypePicker } from "./TypePicker";

// One row of the memory grid: offset, absolute address, raw bytes (always shown), name (or
// live ASCII preview), type, and the decoded value. An untyped row shows only its bytes and
// dims the value column; choosing a type fills the value in. Value characters that changed
// since the previous tick are highlighted via diffSegments. Pointer rows additionally show a
// peek of the bytes at the target and, when resolved, its RTTI class name.

const ASCII_MAX = 16;

export interface NodeRowProps {
    node: Node;
    offset: number;
    baseAddress: string;
    snapshot: Accessor<MemorySnapshot | null | undefined>;
    selected: boolean;
    editing: boolean;
    onSelect: (e: MouseEvent) => void;
    onChangeType: (typeId: NodeTypeId) => void;
    onStartRename: () => void;
    onCommitRename: (name: string) => void;
    onCancelRename: () => void;
    onContextMenu: (e: MouseEvent) => void;
    onDelete: () => void;
    onFollow: (target: string, name?: string) => void;
}

export function NodeRow(props: NodeRowProps) {
    const type = () => nodeType(props.node.typeId);
    const byteSize = () => nodeByteSize(props.node);
    const inBounds = (snap: MemorySnapshot) => props.offset + byteSize() <= snap.view.byteLength;

    // Strings decode length-aware (their span lives on the node, not the type); everything else
    // goes through the type registry's fixed decode.
    const decode = (view: DataView): string | undefined =>
        isStringType(props.node.typeId)
            ? readString(view, props.offset, byteSize(), props.node.typeId === "wstring")
            : type().decode(view, props.offset);

    const address = createMemo(() =>
        props.baseAddress ? (parseHex(props.baseAddress) + BigInt(props.offset)).toString(16) : "",
    );

    const value = createMemo(() => {
        const snap = props.snapshot();
        return snap && inBounds(snap) ? decode(snap.view) : undefined;
    });
    const prevValue = createMemo(() => {
        const snap = props.snapshot();
        return snap?.prev && inBounds(snap) ? decode(snap.prev) : undefined;
    });

    const hex = createMemo(() => {
        const snap = props.snapshot();
        return snap && inBounds(snap) ? bytePairs(snap.view, props.offset, byteSize()) : "";
    });

    const ascii = createMemo(() => {
        const snap = props.snapshot();
        return snap && inBounds(snap)
            ? asciiPreview(snap.view, props.offset, Math.min(byteSize(), ASCII_MAX))
            : "";
    });

    const pointer = () => (type().category === "pointer" ? props.snapshot()?.pointers.get(props.node.id) : undefined);
    // A pointer is "followable" once it has a non-null target; following spawns a new class
    // there, named by the resolved RTTI class (or the field name) when we have one.
    const followTarget = () => {
        const p = pointer();
        return p && p.target !== "0x0" ? p : undefined;
    };

    const offsetLabel = () => props.offset.toString(16).toUpperCase().padStart(4, "0");

    return (
        <div
            class="node-row"
            classList={{ selected: props.selected }}
            onClick={(e) => props.onSelect(e)}
            onContextMenu={(e) => props.onContextMenu(e)}
        >
            <span class="col-offset">{offsetLabel()}</span>
            <span class="col-address">{address()}</span>
            <span class="col-hex">{hex()}</span>

            <Show
                when={props.editing}
                fallback={
                    <span
                        class="col-name"
                        classList={{ named: props.node.name !== undefined }}
                        title="double-click to rename"
                        onDblClick={(e) => {
                            e.stopPropagation();
                            props.onStartRename();
                        }}
                    >
                        {props.node.name ?? ascii()}
                    </span>
                }
            >
                <RenameInput
                    class="col-name rename"
                    value={props.node.name ?? ""}
                    placeholder={ascii()}
                    onCommit={props.onCommitRename}
                    onCancel={props.onCancelRename}
                />
            </Show>

            <span class="col-type">
                <TypePicker typeId={props.node.typeId} onChange={props.onChangeType} />
            </span>

            <span class="col-value">
                <span class="value-text">
                    <Show when={value()} fallback={<span class="dim">-</span>}>
                        {(v) => (
                            <For each={diffSegments(prevValue(), v())}>
                                {(seg) => <span classList={{ changed: seg.changed }}>{seg.text}</span>}
                            </For>
                        )}
                    </Show>
                    <Show when={pointer()?.previewHex}>
                        {(hex) => (
                            <>
                                <span class="ptr-arrow">→</span>
                                <span class="ptr-preview">{hexPairs(hex())}</span>
                            </>
                        )}
                    </Show>
                </span>
                <Show when={followTarget()}>
                    {(p) => (
                        <button
                            class="ptr-follow"
                            title={`open ${p().target} as a new class`}
                            onClick={(e) => {
                                e.stopPropagation();
                                props.onFollow(p().target, p().rttiName ?? props.node.name);
                            }}
                        >
                            follow pointer
                        </button>
                    )}
                </Show>
                <Show when={pointer()?.rttiName}>
                    {(name) => <span class="class-tag">class {name()}</span>}
                </Show>
            </span>

            <button
                class="node-delete"
                title="delete node"
                onClick={(e) => {
                    e.stopPropagation();
                    props.onDelete();
                }}
            >
                ✕
            </button>
        </div>
    );
}
