import { For, Show, createMemo, type Accessor } from "solid-js";
import { parseHex } from "../../../state/address";
import { asciiPreview, bytePairsDiff, diffSegments, hexPairs } from "../nodes/format";
import { decodeNode } from "../nodes/decode";
import { isRefType, nodeByteSize, nodeType, sparklinePoints, type Node, type NodeTypeId } from "../nodes/types";
import type { Confidence } from "../nodes/guess";
import type { SetTypeOptions } from "../nodes/layout";
import type { MemorySnapshot } from "../state/useMemorySnapshot";
import { RenameInput } from "../../../ui/RenameInput";
import { TypePicker } from "./TypePicker";
import { ValueEditor } from "./ValueEditor";
import { useDataTypes } from "../../datatypes/state/DataTypesContext";

// One row of the memory grid: offset, absolute address, raw bytes (always shown), name (or
// live ASCII preview), type, and the decoded value. An untyped row shows only its bytes and
// dims the value column; choosing a type fills the value in. Value characters that changed
// since the previous tick are highlighted via diffSegments; a field changed from the captured
// BASELINE gets a separate persistent marker. Pointer rows additionally show a peek of the
// bytes at the target and, when resolved, its RTTI class name. The value cell doubles as the
// inline typed editor (double-click / Enter).

const ASCII_MAX = 16;

export interface RowSuggestion {
    label: string;
    confidence: Confidence;
    reason: string;
}

export interface NodeRowProps {
    node: Node;
    offset: number;
    baseAddress: string;
    snapshot: Accessor<MemorySnapshot | null | undefined>;
    /** Recent numeric values of this node, for the value sparkline (absent for non-numeric types). */
    history?: number[];
    selected: boolean;
    /** True when this row is the keyboard focus row (drives the focus ring). */
    focused: boolean;
    /** Changed from the captured baseline (persistent marker, distinct from the per-tick diff). */
    baselineChanged: boolean;
    editing: boolean;
    /** Inline value editing state for this row. */
    editingValue: boolean;
    valuePending: boolean;
    valueWriteError?: string;
    canEditValue: boolean;
    validateValue: (text: string) => string | undefined;
    valueEditText: () => string;
    onStartEditValue: () => void;
    onCommitValue: (text: string) => void;
    onCancelEditValue: () => void;
    /** Pending analysis suggestion for this row, with accept/reject. */
    suggestion?: RowSuggestion;
    onAcceptSuggestion: () => void;
    onRejectSuggestion: () => void;
    onSelect: (e: MouseEvent) => void;
    onChangeType: (typeId: NodeTypeId, opts?: SetTypeOptions) => void;
    onStartRename: () => void;
    onCommitRename: (name: string) => void;
    onCancelRename: () => void;
    onContextMenu: (e: MouseEvent) => void;
    onDelete: () => void;
    onFollow: (target: string, name?: string) => void;
    /** Whether this pointer/struct row is expanded inline, and a toggle for it. */
    expanded: boolean;
    onToggleExpand: () => void;
}

export function NodeRow(props: NodeRowProps) {
    const dt = useDataTypes();
    const type = () => nodeType(props.node.typeId);
    const byteSize = () => nodeByteSize(props.node);
    const inBounds = (snap: MemorySnapshot) => props.offset + byteSize() <= snap.view.byteLength;

    const decode = (view: DataView): string | undefined =>
        decodeNode(view, props.offset, props.node, {
            formatEnum: (name, value) => (dt.enumByName(name) ? dt.formatEnumValue(name, value) : undefined),
            hasStruct: (name) => dt.structByName(name) !== undefined,
        });

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
        return snap && inBounds(snap) ? bytePairsDiff(snap.view, snap.prev, props.offset, byteSize()) : [];
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
    const expandable = () => !!followTarget() || (isRefType(props.node.typeId) && props.node.typeId === "structref");

    const offsetLabel = () => props.offset.toString(16).toUpperCase().padStart(4, "0");

    const tryStartValueEdit = (e: MouseEvent) => {
        e.stopPropagation();
        if (props.canEditValue && !props.editingValue) props.onStartEditValue();
    };

    return (
        <div
            class="node-row"
            role="option"
            aria-selected={props.selected}
            classList={{
                selected: props.selected,
                focused: props.focused,
                "baseline-changed": props.baselineChanged,
                locked: props.node.locked === true,
                suggested: props.suggestion !== undefined,
            }}
            onClick={(e) => props.onSelect(e)}
            onContextMenu={(e) => props.onContextMenu(e)}
        >
            <span class="col-offset">
                <Show when={props.baselineChanged}>
                    <span class="baseline-dot" title="changed from baseline" />
                </Show>
                {offsetLabel()}
            </span>
            <span class="col-address">{address()}</span>
            <span class="col-hex">
                <For each={hex()}>{(seg) => <span classList={{ changed: seg.changed }}>{seg.text}</span>}</For>
            </span>

            <Show
                when={props.editing}
                fallback={
                    <span
                        class="col-name"
                        classList={{ named: props.node.name !== undefined }}
                        title="double-click to rename (F2)"
                        onDblClick={(e) => {
                            e.stopPropagation();
                            props.onStartRename();
                        }}
                    >
                        <Show when={props.node.locked}>
                            <span class="lock-tag" title="locked against automatic analysis">🔒</span>
                        </Show>
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
                <TypePicker node={props.node} onChange={props.onChangeType} />
                <Show when={props.suggestion}>
                    {(s) => (
                        <span
                            class={`suggestion-chip conf-${s().confidence}`}
                            title={`${s().confidence} confidence: ${s().reason}`}
                        >
                            <span class="suggestion-label">→ {s().label}</span>
                            <button
                                class="suggestion-act accept"
                                title="accept suggestion"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    props.onAcceptSuggestion();
                                }}
                            >
                                ✓
                            </button>
                            <button
                                class="suggestion-act reject"
                                title="reject suggestion"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    props.onRejectSuggestion();
                                }}
                            >
                                ✗
                            </button>
                        </span>
                    )}
                </Show>
            </span>

            <span class="col-value" onDblClick={tryStartValueEdit}>
                <Show when={expandable()}>
                    <button
                        class="node-disclosure"
                        title={props.expanded ? "collapse inline expansion" : "expand inline"}
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onToggleExpand();
                        }}
                    >
                        {props.expanded ? "▾" : "▸"}
                    </button>
                </Show>

                <Show
                    when={props.editingValue}
                    fallback={
                        <span class="value-text" title={props.canEditValue ? "double-click to edit value" : undefined}>
                            <Show when={value()} fallback={<span class="dim">-</span>}>
                                {(v) => (
                                    <For each={diffSegments(prevValue(), v())}>
                                        {(seg) => <span classList={{ changed: seg.changed }}>{seg.text}</span>}
                                    </For>
                                )}
                            </Show>
                            <Show when={props.history && props.history.length > 2}>
                                <svg class="value-spark" width="52" height="14" viewBox="0 0 52 14" preserveAspectRatio="none">
                                    <polyline points={sparklinePoints(props.history!, 52, 12)} fill="none" stroke="currentColor" stroke-width="1" />
                                </svg>
                            </Show>
                            <Show when={pointer()?.previewHex}>
                                {(h) => (
                                    <>
                                        <span class="ptr-arrow">→</span>
                                        <span class="ptr-preview">{hexPairs(h())}</span>
                                    </>
                                )}
                            </Show>
                        </span>
                    }
                >
                    <ValueEditor
                        initial={props.valueEditText()}
                        validate={props.validateValue}
                        pending={props.valuePending}
                        writeError={props.valueWriteError}
                        onCommit={props.onCommitValue}
                        onCancel={props.onCancelEditValue}
                    />
                </Show>

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
