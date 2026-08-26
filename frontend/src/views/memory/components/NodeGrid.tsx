import { For, Show, createEffect, createMemo, createSignal, untrack, type Accessor } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { parseHex, toHex } from "../../../state/address";
import { useApp } from "../../../app/AppContext";
import { write } from "../../../protocol/requests";
import { errorText } from "../../../state/errors";
import { createListVirtualizer } from "../../../ui/virtualList";
import { bytePairs } from "../nodes/format";
import { decodeNode } from "../nodes/decode";
import { offsets } from "../nodes/layout";
import { changedFromBaseline, type Baseline } from "../nodes/baseline";
import { editText, encodeValue, isEditableType } from "../nodes/encode";
import { gridKeyAction, isTypingTarget, rangeBetween } from "../nodes/gridKeys";
import { nodeByteSize, nodeNumericValue, type Node } from "../nodes/types";
import { buildCopyText, type CopyContext, type CopyFormat } from "../nodes/copy";
import type { Suggestion } from "../nodes/guess";
import { useMemory } from "../state/MemoryContext";
import type { MemorySnapshot } from "../state/useMemorySnapshot";
import { useDataTypes } from "../../datatypes/state/DataTypesContext";
import { NodeContextMenu } from "./NodeContextMenu";
import { NodeRow, type RowSuggestion } from "./NodeRow";
import { PointerExpansion } from "./PointerExpansion";
import { StructExpansion } from "./StructExpansion";
import { BitNamesModal } from "./BitNamesModal";

const ROW_HEIGHT = 30;

// Width reserved for the menu plus a flown-out submenu, so we can flip submenus to the left when
// the cursor is too close to the right edge to fit them.
const MENU_REACH = 460;

interface MenuState {
    x: number;
    y: number;
    flip: boolean;
}

/** Imperative surface the view uses for "go to offset" / search-result navigation. */
export interface GridController {
    /** Scroll to a position in the FILTERED list and move keyboard focus there. */
    scrollToPosition: (pos: number) => void;
}

// The virtualized node table: a fixed header plus the rows of the active class, virtualized
// over the FILTERED row list. Every item carries its original node index, so structural edits
// (rename, retype, delete, insert, repeat, create-class) always address the real node even
// while a search or filter hides most of the class. Rename state is held here (one node at a
// time); structural edits delegate to the memory store by original index. Keyboard navigation,
// range selection, and the inline typed value editor also live here.

export function NodeGrid(props: {
    nodes: Accessor<Node[]>;
    baseAddress: Accessor<string>;
    snapshot: Accessor<MemorySnapshot | null | undefined>;
    baseline: Accessor<Baseline | undefined>;
    /** Original node indices currently shown (filter/search output, in order). */
    visible: Accessor<number[]>;
    paused: Accessor<boolean>;
    suggestions: Accessor<ReadonlyMap<string, Suggestion>>;
    suggestionLabel: (s: Suggestion) => string;
    onAcceptSuggestion: (nodeId: string) => void;
    onRejectSuggestion: (nodeId: string) => void;
    onDismissSuggestions: () => void;
    /** Report the node ids currently rendered, for pointer-preview prioritization. */
    onVisibleIds: (ids: ReadonlySet<string>) => void;
    /** Re-read the region after a successful write (never fake bytes locally). */
    onWriteDone: () => void;
    controller?: (api: GridController) => void;
}) {
    const app = useApp();
    const memory = useMemory();
    const dt = useDataTypes();
    const offs = createMemo(() => offsets(props.nodes()));

    const [editingId, setEditingId] = createSignal<string | null>(null);
    const [menu, setMenu] = createSignal<MenuState | null>(null);
    const [bitNamesId, setBitNamesId] = createSignal<string | null>(null);
    // Keyboard focus: a position within the filtered list, plus the range-selection anchor.
    const [focusPos, setFocusPos] = createSignal<number | null>(null);
    let anchorPos: number | null = null;

    const { setRef, virtualizer } = createListVirtualizer(() => props.visible().length, ROW_HEIGHT);
    let containerEl: HTMLDivElement | undefined;

    const nodeAt = (pos: number): Node | undefined => props.nodes()[props.visible()[pos]];
    const posOfNode = (nodeId: string): number | null => {
        const v = props.visible();
        const nodes = props.nodes();
        for (let i = 0; i < v.length; i++) if (nodes[v[i]]?.id === nodeId) return i;
        return null;
    };

    // Keep focus meaningful across filtering/virtualization: if the focused row is filtered out,
    // clamp to the list; selection itself is id-based and survives untouched.
    createEffect(() => {
        const count = props.visible().length;
        const pos = untrack(focusPos);
        if (pos !== null && pos >= count) setFocusPos(count === 0 ? null : count - 1);
    });

    // Report rendered node ids for preview prioritization (dedup-guarded to avoid effect loops).
    let lastVisibleKey = "";
    createEffect(() => {
        const items = virtualizer.getVirtualItems();
        const nodes = props.nodes();
        const v = props.visible();
        const ids = new Set<string>();
        for (const it of items) {
            const n = nodes[v[it.index]];
            if (n) ids.add(n.id);
        }
        const key = [...ids].join(",");
        if (key !== lastVisibleKey) {
            lastVisibleKey = key;
            props.onVisibleIds(ids);
        }
    });

    // --- selection ---------------------------------------------------------------------------

    const selectSingle = (pos: number) => {
        const n = nodeAt(pos);
        if (!n) return;
        memory.selectNode(n.id);
        setFocusPos(pos);
        anchorPos = pos;
    };

    const selectRange = (from: number, to: number) => {
        const ids = rangeBetween(from, to)
            .map((p) => nodeAt(p)?.id)
            .filter((id): id is string => id !== undefined);
        memory.setSelection(ids);
        setFocusPos(to);
    };

    const onRowClick = (pos: number, e: MouseEvent) => {
        if (e.shiftKey && anchorPos !== null) {
            selectRange(anchorPos, pos);
        } else if (e.ctrlKey || e.metaKey) {
            const n = nodeAt(pos);
            if (n) memory.toggleNode(n.id);
            setFocusPos(pos);
            anchorPos = pos;
        } else {
            selectSingle(pos);
        }
    };

    const scrollToPosition = (pos: number) => {
        if (props.visible().length === 0) return;
        const clamped = Math.max(0, Math.min(props.visible().length - 1, pos));
        virtualizer.scrollToIndex(clamped, { align: "auto" });
        setFocusPos(clamped);
        anchorPos = clamped;
    };
    props.controller?.({ scrollToPosition });

    // --- inline value editing ----------------------------------------------------------------

    const [valueEdit, setValueEdit] = createStore<{ nodeId: string | null; pending: boolean; error?: string }>({
        nodeId: null,
        pending: false,
    });

    const refResolvers = {
        formatEnum: (name: string, value: number) =>
            dt.enumByName(name) ? dt.formatEnumValue(name, value) : undefined,
        hasStruct: (name: string) => dt.structByName(name) !== undefined,
    };
    const encodeRefs = {
        enumValue: (enumName: string, member: string) =>
            dt.enumByName(enumName)?.members.find((m) => m.name === member)?.value,
    };

    const canEditValue = (node: Node, offset: number): boolean => {
        if (!app.attached() || !props.baseAddress() || !isEditableType(node)) return false;
        const snap = props.snapshot();
        return !!snap && offset + nodeByteSize(node) <= snap.view.byteLength;
    };

    const startValueEdit = (node: Node) => {
        if (valueEdit.pending) return;
        setValueEdit(produce((s) => {
            s.nodeId = node.id;
            s.error = undefined;
        }));
    };

    const cancelValueEdit = () => {
        if (valueEdit.pending) return;
        setValueEdit(produce((s) => {
            s.nodeId = null;
            s.error = undefined;
        }));
        containerEl?.focus();
    };

    const commitValueEdit = (origIndex: number, text: string) => {
        // One write at a time: a pending write ignores further commits (no duplicates).
        if (valueEdit.pending) return;
        const node = props.nodes()[origIndex];
        if (!node) return;
        const enc = encodeValue(node, text, encodeRefs);
        if (!enc.ok) {
            setValueEdit("error", enc.error);
            return;
        }
        const address = toHex(parseHex(props.baseAddress()) + BigInt(offs()[origIndex]));
        setValueEdit(produce((s) => {
            s.pending = true;
            s.error = undefined;
        }));
        write(app.client, { address, data: enc.hex })
            .then((res) => {
                if (!res.success) {
                    setValueEdit(produce((s) => {
                        s.pending = false;
                        s.error = "write failed (protected page?)";
                    }));
                    return;
                }
                // Success: close the editor and re-read the region - the grid shows only what the
                // process actually contains, never a locally faked snapshot.
                setValueEdit(produce((s) => {
                    s.pending = false;
                    s.nodeId = null;
                    s.error = undefined;
                }));
                props.onWriteDone();
                containerEl?.focus();
            })
            .catch((e) => {
                setValueEdit(produce((s) => {
                    s.pending = false;
                    s.error = errorText(e);
                }));
            });
    };

    // --- context menu ------------------------------------------------------------------------

    // Right-clicking a node outside the current selection first selects just that node, so the
    // menu always acts on something sensible; right-clicking inside the selection keeps it.
    const openMenu = (e: MouseEvent, nodeId: string) => {
        e.preventDefault();
        if (!memory.isSelected(nodeId)) memory.selectNode(nodeId);
        const pos = posOfNode(nodeId);
        if (pos !== null) setFocusPos(pos);
        // Keep the menu on-screen when right-clicking near the right/bottom edge.
        const x = Math.min(e.clientX, window.innerWidth - 240);
        const y = Math.min(e.clientY, window.innerHeight - 320);
        setMenu({ x, y, flip: e.clientX > window.innerWidth - MENU_REACH });
    };

    // Keyboard-opened menu (ContextMenu key / Shift+F10): anchored at the focused row.
    const openMenuAtFocus = () => {
        const pos = focusPos();
        if (pos === null || !containerEl) return;
        const n = nodeAt(pos);
        if (!n) return;
        if (!memory.isSelected(n.id)) memory.selectNode(n.id);
        const rect = containerEl.getBoundingClientRect();
        const item = virtualizer.getVirtualItems().find((it) => it.index === pos);
        const y = rect.top + (item ? item.start - virtualizer.scrollOffset! : 0) + ROW_HEIGHT;
        setMenu({
            x: Math.min(rect.left + 160, window.innerWidth - 240),
            y: Math.max(0, Math.min(y, window.innerHeight - 320)),
            flip: false,
        });
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
            value = decodeNode(snap.view, offset, node, refResolvers);
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

    // The lone selected node + index (for the per-field menu options and F2/Enter targets).
    const loneSelected = (): { node: Node; index: number } | undefined => {
        const ids = memory.selectedNodeIds;
        if (ids.length !== 1) return undefined;
        const index = props.nodes().findIndex((n) => n.id === ids[0]);
        return index >= 0 ? { node: props.nodes()[index], index } : undefined;
    };

    const origIndexOfPos = (pos: number): number | undefined => props.visible()[pos];

    // Per-node value history for the sparkline. Each poll appends every numeric node's current
    // value (capped to a short window); non-numeric nodes are skipped. Keyed by node id so it
    // survives reordering and filtering; stale ids from deleted nodes simply stop updating.
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

    // --- keyboard ----------------------------------------------------------------------------

    const onKeyDown = (e: KeyboardEvent) => {
        // Never steal keys from inputs, editors, or modal windows.
        if (isTypingTarget(e.target)) return;
        const pageSize = Math.max(1, Math.floor((containerEl?.clientHeight ?? ROW_HEIGHT) / ROW_HEIGHT));
        const action = gridKeyAction(
            e.key,
            { shift: e.shiftKey, ctrlOrMeta: e.ctrlKey || e.metaKey },
            { rowCount: props.visible().length, focusIndex: focusPos(), pageSize },
        );
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();

        switch (action.type) {
            case "focus": {
                if (action.extend && anchorPos !== null) {
                    selectRange(anchorPos, action.index);
                } else {
                    selectSingle(action.index);
                }
                virtualizer.scrollToIndex(action.index, { align: "auto" });
                break;
            }
            case "selectAll": {
                const ids = props.visible()
                    .map((i) => props.nodes()[i]?.id)
                    .filter((id): id is string => id !== undefined);
                memory.setSelection(ids);
                break;
            }
            case "edit": {
                const pos = focusPos();
                if (pos === null) break;
                const orig = origIndexOfPos(pos);
                const n = orig !== undefined ? props.nodes()[orig] : undefined;
                if (n && orig !== undefined && canEditValue(n, offs()[orig])) startValueEdit(n);
                break;
            }
            case "rename": {
                const n = focusPos() !== null ? nodeAt(focusPos()!) : undefined;
                if (n) setEditingId(n.id);
                break;
            }
            case "delete":
                memory.deleteSelected();
                break;
            case "menu":
                openMenuAtFocus();
                break;
            case "escape": {
                if (menu()) setMenu(null);
                else if (valueEdit.nodeId) cancelValueEdit();
                else if (editingId()) setEditingId(null);
                else if (props.suggestions().size > 0) props.onDismissSuggestions();
                else memory.clearSelection();
                break;
            }
        }
    };

    return (
        <div class="node-grid">
            <div class="node-head" role="presentation">
                <span class="col-offset">offset</span>
                <span class="col-address">address</span>
                <span class="col-hex">bytes</span>
                <span class="col-name">name</span>
                <span class="col-type">type</span>
                <span class="col-value">value</span>
                <span class="col-actions" />
            </div>

            <div
                ref={(el) => {
                    containerEl = el;
                    setRef(el);
                }}
                class="list"
                role="listbox"
                aria-label="class fields"
                aria-multiselectable="true"
                tabindex="0"
                onKeyDown={onKeyDown}
            >
                <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
                    <For each={virtualizer.getVirtualItems()}>
                        {(item) => {
                            // A switch to a class with fewer nodes (or a narrower filter) can leave
                            // the virtualizer holding items indexed past the new list for a tick
                            // before it recomputes. Guard on the node existing so a stale item
                            // renders nothing instead of feeding undefined into NodeRow's math.
                            const origIndex = () => props.visible()[item.index];
                            const node = () => (origIndex() === undefined ? undefined : props.nodes()[origIndex()]);
                            return (
                                <Show when={node()}>
                                    {(n) => {
                                        // A pointer/struct row's inline expansion grows the host past one
                                        // row, so the host is measured (data-index + measureElement)
                                        // instead of hard-set to the row height.
                                        const expanded = () => memory.isExpanded(n().id);
                                        const target = () => pointerTarget(n().id);
                                        const offset = () => offs()[origIndex()];
                                        const suggestion = (): RowSuggestion | undefined => {
                                            const s = props.suggestions().get(n().id);
                                            return s
                                                ? { label: props.suggestionLabel(s), confidence: s.confidence, reason: s.reason }
                                                : undefined;
                                        };
                                        const baselineChanged = () => {
                                            const snap = props.snapshot();
                                            const base = props.baseline();
                                            return !!snap && !!base && base.key === snap.key
                                                ? changedFromBaseline(snap.view, base, offset(), nodeByteSize(n()))
                                                : false;
                                        };
                                        return (
                                            <div
                                                class="node-row-host"
                                                data-index={item.index}
                                                ref={(el) => {
                                                    // Set data-index imperatively BEFORE measuring: Solid runs this
                                                    // ref before it applies the reactive data-index attribute, and
                                                    // @tanstack/solid-virtual's measureElement warns (and skips) when
                                                    // the attribute is missing at measure time.
                                                    el.setAttribute("data-index", String(item.index));
                                                    virtualizer.measureElement(el);
                                                }}
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
                                                    offset={offset()}
                                                    baseAddress={props.baseAddress()}
                                                    snapshot={props.snapshot}
                                                    history={history[n().id]}
                                                    selected={memory.isSelected(n().id)}
                                                    focused={focusPos() === item.index}
                                                    baselineChanged={baselineChanged()}
                                                    editing={editingId() === n().id}
                                                    editingValue={valueEdit.nodeId === n().id}
                                                    valuePending={valueEdit.nodeId === n().id && valueEdit.pending}
                                                    valueWriteError={valueEdit.nodeId === n().id ? valueEdit.error : undefined}
                                                    canEditValue={canEditValue(n(), offset())}
                                                    validateValue={(text) => {
                                                        const r = encodeValue(n(), text, encodeRefs);
                                                        return r.ok ? undefined : r.error;
                                                    }}
                                                    valueEditText={() => {
                                                        const snap = props.snapshot();
                                                        return snap ? editText(n(), snap.view, offset()) : "";
                                                    }}
                                                    onStartEditValue={() => startValueEdit(n())}
                                                    onCommitValue={(text) => commitValueEdit(origIndex(), text)}
                                                    onCancelEditValue={cancelValueEdit}
                                                    suggestion={suggestion()}
                                                    onAcceptSuggestion={() => props.onAcceptSuggestion(n().id)}
                                                    onRejectSuggestion={() => props.onRejectSuggestion(n().id)}
                                                    onSelect={(e) => onRowClick(item.index, e)}
                                                    onChangeType={(typeId, opts) => memory.setNodeType(origIndex(), typeId, opts)}
                                                    onStartRename={() => setEditingId(n().id)}
                                                    onCommitRename={(name) => {
                                                        memory.renameNode(origIndex(), name);
                                                        setEditingId(null);
                                                    }}
                                                    onCancelRename={() => setEditingId(null)}
                                                    onContextMenu={(e) => openMenu(e, n().id)}
                                                    onDelete={() => memory.deleteNode(origIndex())}
                                                    onFollow={(target, name) => memory.addClassAt(target, name)}
                                                    expanded={expanded()}
                                                    onToggleExpand={() => memory.toggleExpanded(n().id)}
                                                />
                                                <Show when={expanded() && target()}>
                                                    {(addr) => (
                                                        <PointerExpansion
                                                            address={addr()}
                                                            path={n().id}
                                                            depth={1}
                                                            paused={props.paused}
                                                        />
                                                    )}
                                                </Show>
                                                <Show
                                                    when={
                                                        expanded() && n().typeId === "structref" && n().refName
                                                            ? props.snapshot() ?? undefined
                                                            : undefined
                                                    }
                                                >
                                                    {(snap) => (
                                                        <StructExpansion
                                                            refName={n().refName!}
                                                            baseOffset={offset()}
                                                            baseAddress={props.baseAddress()}
                                                            view={snap().view}
                                                            depth={1}
                                                        />
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
                        node={loneSelected()?.node}
                        allLocked={
                            memory.selectedNodeIds.length > 0 &&
                            memory.selectedNodeIds.every((id) => props.nodes().find((n) => n.id === id)?.locked === true)
                        }
                        copyAvailable={copyAvailable()}
                        onChangeType={(typeId) => memory.setSelectedType(typeId)}
                        onAddBytes={(bytes) => memory.addBytes(bytes)}
                        onInsertBytes={(bytes) => memory.insertBytesAboveSelection(bytes)}
                        onCreateClass={() => memory.createClassFromSelection()}
                        onDelete={() => memory.deleteSelected()}
                        onRepeat={(count) => memory.repeatSelection(count)}
                        onCopy={doCopy}
                        onSetDisplayFormat={(format) => {
                            const sel = loneSelected();
                            if (sel) memory.setNodeMeta(sel.index, { displayFormat: format });
                        }}
                        onSetEndian={(endian) => {
                            const sel = loneSelected();
                            if (sel) memory.setNodeMeta(sel.index, { endian });
                        }}
                        onSetLength={(bytes) => {
                            const sel = loneSelected();
                            if (sel) memory.setNodeLength(sel.index, bytes);
                        }}
                        onSetLocked={(locked) => memory.setSelectedLocked(locked)}
                        onEditBitNames={() => {
                            const sel = loneSelected();
                            if (sel) setBitNamesId(sel.node.id);
                        }}
                        onClose={() => setMenu(null)}
                    />
                )}
            </Show>

            <BitNamesModal
                node={props.nodes().find((n) => n.id === bitNamesId())}
                onSave={(names) => {
                    const index = props.nodes().findIndex((n) => n.id === bitNamesId());
                    if (index >= 0) memory.setNodeMeta(index, { bitNames: names });
                }}
                onClose={() => setBitNamesId(null)}
            />
        </div>
    );
}

