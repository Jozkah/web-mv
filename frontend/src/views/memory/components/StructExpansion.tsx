import { For, Show, createMemo, createSignal } from "solid-js";
import { parseHex, toHex } from "../../../state/address";
import { bytePairs } from "../nodes/format";
import { decodeNode } from "../nodes/decode";
import { NODE_TYPES, type Node } from "../nodes/types";
import { useDataTypes } from "../../datatypes/state/DataTypesContext";
import type { StructField } from "../../../state/dataTypesStore";

// Inline expansion of a structref node: the referenced struct's fields rendered beneath the
// row, decoded straight from the MAIN region snapshot (the struct lies inside the class span,
// so no extra reads happen). Nested struct fields expand recursively up to a depth cap.
// Collapse state is local - it's a peek, not part of the class definition.

const MAX_DEPTH = 4;

interface ResolvedField {
    field: StructField;
    offset: number; // relative to the struct's own base
    size: number;
}

export function StructExpansion(props: {
    refName: string;
    /** Offset of the structref node within the class region. */
    baseOffset: number;
    baseAddress: string;
    view: DataView;
    depth: number;
}) {
    const dt = useDataTypes();
    const def = () => dt.structByName(props.refName);

    // Walk the definition once per registry change: each field's relative offset + size.
    const fields = createMemo<ResolvedField[]>(() => {
        const d = def();
        if (!d) return [];
        const out: ResolvedField[] = [];
        let off = 0;
        for (const f of d.fields) {
            const size = fieldByteSize(dt, f);
            out.push({ field: f, offset: off, size });
            off += size;
        }
        return out;
    });

    const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
    const toggle = (id: string) =>
        setOpen((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    // Decode a field through the shared node decoder by shaping it as a pseudo-node.
    const decodeField = (rf: ResolvedField): string | undefined => {
        const f = rf.field;
        const node: Node =
            f.kind === "enum"
                ? { id: f.id, typeId: "enumref", refName: f.refName, length: rf.size }
                : { id: f.id, typeId: f.typeId, length: f.length };
        return decodeNode(props.view, props.baseOffset + rf.offset, node, {
            formatEnum: (name, value) => (dt.enumByName(name) ? dt.formatEnumValue(name, value) : undefined),
            hasStruct: (name) => dt.structByName(name) !== undefined,
        });
    };

    return (
        <div class="struct-expand" role="group" aria-label={`struct ${props.refName}`}>
            <Show
                when={def()}
                fallback={<div class="ptr-expand-status">struct {props.refName} is not defined in Data Types</div>}
            >
                <For each={fields()}>
                    {(rf) => {
                        const absOffset = () => props.baseOffset + rf.offset;
                        const address = () =>
                            props.baseAddress ? toHex(parseHex(props.baseAddress) + BigInt(absOffset())) : "";
                        const inBounds = () => absOffset() + rf.size <= props.view.byteLength;
                        const isStruct = () => rf.field.kind === "struct";
                        const canExpand = () => isStruct() && props.depth < MAX_DEPTH && !!rf.field.refName;
                        const typeLabel = () =>
                            rf.field.kind === "primitive"
                                ? NODE_TYPES[rf.field.typeId].label
                                : `${rf.field.kind} ${rf.field.refName ?? "?"}`;
                        return (
                            <>
                                <div class="ptr-expand-row">
                                    <span class="pe-disclosure">
                                        <Show when={canExpand()}>
                                            <button
                                                class="node-disclosure"
                                                title="expand nested struct"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggle(rf.field.id);
                                                }}
                                            >
                                                {open().has(rf.field.id) ? "▾" : "▸"}
                                            </button>
                                        </Show>
                                    </span>
                                    <span class="col-offset">{absOffset().toString(16).toUpperCase().padStart(4, "0")}</span>
                                    <span class="col-address">{address().slice(2)}</span>
                                    <span class="col-hex">
                                        {inBounds() ? bytePairs(props.view, absOffset(), Math.min(rf.size, 8)) : ""}
                                    </span>
                                    <span class="col-type">{typeLabel()}</span>
                                    <span class="col-value">
                                        <span class="value-text">
                                            {rf.field.name}
                                            <Show when={!isStruct() && inBounds()}>
                                                <span class="struct-field-value"> = {decodeField(rf) ?? "-"}</span>
                                            </Show>
                                        </span>
                                    </span>
                                </div>
                                <Show when={canExpand() && open().has(rf.field.id) && rf.field.refName}>
                                    <StructExpansion
                                        refName={rf.field.refName!}
                                        baseOffset={absOffset()}
                                        baseAddress={props.baseAddress}
                                        view={props.view}
                                        depth={props.depth + 1}
                                    />
                                </Show>
                            </>
                        );
                    }}
                </For>
            </Show>
        </div>
    );
}

// Byte span of one struct field, resolving refs through the registry (cycles contribute 0 via
// dataTypesStore's own guard).
function fieldByteSize(dt: ReturnType<typeof useDataTypes>, f: StructField): number {
    if (f.kind === "primitive") {
        const t = NODE_TYPES[f.typeId];
        return t.category === "string" ? f.length ?? 0 : t.size;
    }
    if (f.kind === "enum") {
        const en = f.refName ? dt.enumByName(f.refName) : undefined;
        return NODE_TYPES[en?.underlying ?? "int32"].size;
    }
    const target = f.refName ? dt.structByName(f.refName) : undefined;
    return target ? dt.sizeOf(target) : 0;
}
