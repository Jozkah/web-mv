import { For, Show, createSignal } from "solid-js";
import { useDataTypes } from "./state/DataTypesContext";
import { NODE_TYPE_LIST, type PrimitiveTypeId } from "../memory/nodes/types";
import type { EnumDef, FieldKind, StructDef, StructField } from "../../state/dataTypesStore";
import "./datatypes.css";

// The Data-type manager view: a two-column CRUD editor over the global registry of user-defined
// structs and enums. Structs list their fields (each a primitive or a named struct/enum ref) with a
// live byte-offset column; enums list their name/value members. A toolbar exports/imports the whole
// registry as JSON. No live process is involved - this is pure metadata authoring.

type Tab = "structs" | "enums";

export function DataTypesView() {
    const dt = useDataTypes();
    const [tab, setTab] = createSignal<Tab>("structs");
    const [importError, setImportError] = createSignal("");

    let fileInput: HTMLInputElement | undefined;

    const handleExport = () => {
        const blob = new Blob([dt.exportJson()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "datatypes.json";
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleImportFile = async (e: Event) => {
        const input = e.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        input.value = ""; // allow re-selecting the same file
        if (!file) return;
        const err = dt.importJson(await file.text());
        setImportError(err ?? "");
    };

    return (
        <div class="dt-view">
            <div class="dt-toolbar">
                <div class="dt-tabs">
                    <button
                        class="dt-tab-btn"
                        classList={{ active: tab() === "structs" }}
                        onClick={() => setTab("structs")}
                    >
                        Structs ({dt.counts().structs})
                    </button>
                    <button
                        class="dt-tab-btn"
                        classList={{ active: tab() === "enums" }}
                        onClick={() => setTab("enums")}
                    >
                        Enums ({dt.counts().enums})
                    </button>
                </div>

                <div class="dt-toolbar-spacer" />

                <Show when={tab() === "structs"}>
                    <button class="dt-btn" onClick={() => dt.addStruct()}>+ Struct</button>
                </Show>
                <Show when={tab() === "enums"}>
                    <button class="dt-btn" onClick={() => dt.addEnum()}>+ Enum</button>
                </Show>
                <button class="dt-btn" onClick={handleExport} title="Download the whole registry as JSON">
                    Export
                </button>
                <button class="dt-btn" onClick={() => fileInput?.click()} title="Replace the registry from a JSON file">
                    Import
                </button>
                <input
                    ref={fileInput}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: "none" }}
                    onChange={handleImportFile}
                />
            </div>

            <Show when={importError()}>
                <div class="dt-import-error">Import failed: {importError()}</div>
            </Show>

            <div class="dt-list">
                <Show when={tab() === "structs"}>
                    <Show
                        when={dt.structs.length > 0}
                        fallback={<EmptyState icon="🧱" label="No structs yet. Add one to define a memory layout." />}
                    >
                        <For each={dt.structs}>{(s) => <StructCard struct={s} />}</For>
                    </Show>
                </Show>

                <Show when={tab() === "enums"}>
                    <Show
                        when={dt.enums.length > 0}
                        fallback={<EmptyState icon="🔢" label="No enums yet. Add one to name integer values." />}
                    >
                        <For each={dt.enums}>{(e) => <EnumCard def={e} />}</For>
                    </Show>
                </Show>
            </div>
        </div>
    );
}

function EmptyState(props: { icon: string; label: string }) {
    return (
        <div class="dt-empty">
            <span class="dt-empty-icon">{props.icon}</span>
            <p>{props.label}</p>
        </div>
    );
}

function StructCard(props: { struct: StructDef }) {
    const dt = useDataTypes();
    const s = () => props.struct;

    // Running byte offsets, recomputed each render from the field sizes.
    const offsets = () => {
        const out: number[] = [];
        let off = 0;
        for (const f of s().fields) {
            out.push(off);
            off += fieldByteSize(dt, f);
        }
        return out;
    };

    return (
        <div class="dt-card">
            <div class="dt-card-head">
                <input
                    class="dt-name-input"
                    value={s().name}
                    onChange={(e) => dt.renameStruct(s().id, e.currentTarget.value)}
                />
                <span class="dt-size-tag">{dt.sizeOf(s())} bytes</span>
                <button class="dt-btn dt-btn-sm" onClick={() => dt.addField(s().id)}>+ Field</button>
                <button class="dt-icon-btn" title="Delete struct" onClick={() => dt.removeStruct(s().id)}>×</button>
            </div>

            <Show when={s().fields.length > 0}>
                <div class="dt-field-head">
                    <span>Offset</span>
                    <span>Name</span>
                    <span>Type</span>
                    <span />
                </div>
            </Show>

            <For each={s().fields}>
                {(f, i) => <FieldRow structId={s().id} field={f} offset={offsets()[i()]} />}
            </For>
        </div>
    );
}

function FieldRow(props: { structId: string; field: StructField; offset: number }) {
    const dt = useDataTypes();
    const f = () => props.field;

    const isString = () => f().kind === "primitive" && (f().typeId === "string" || f().typeId === "wstring");

    // A single <select> drives the field type: the primitive list plus every named struct/enum. The
    // selected value is encoded as `p:<primitive>`, `s:<structName>`, or `e:<enumName>`.
    const currentValue = () =>
        f().kind === "primitive" ? `p:${f().typeId}` : f().kind === "struct" ? `s:${f().refName}` : `e:${f().refName}`;

    const onTypeChange = (raw: string) => {
        const [tag, rest] = [raw.slice(0, 1), raw.slice(2)];
        if (tag === "p") {
            dt.updateField(props.structId, f().id, { kind: "primitive", typeId: rest as PrimitiveTypeId, refName: undefined });
        } else {
            const kind: FieldKind = tag === "s" ? "struct" : "enum";
            dt.updateField(props.structId, f().id, { kind, refName: rest });
        }
    };

    return (
        <div class="dt-field-row">
            <span class="dt-offset">+0x{props.offset.toString(16)}</span>
            <input
                class="dt-field-name"
                value={f().name}
                onChange={(e) => dt.updateField(props.structId, f().id, { name: e.currentTarget.value })}
            />
            <div class="dt-field-type">
                <select value={currentValue()} onChange={(e) => onTypeChange(e.currentTarget.value)}>
                    <optgroup label="Primitives">
                        <For each={NODE_TYPE_LIST}>
                            {(t) => <option value={`p:${t.id}`}>{t.label}</option>}
                        </For>
                    </optgroup>
                    <Show when={dt.structs.length > 0}>
                        <optgroup label="Structs">
                            <For each={dt.structs}>
                                {(st) => <option value={`s:${st.name}`}>{st.name}</option>}
                            </For>
                        </optgroup>
                    </Show>
                    <Show when={dt.enums.length > 0}>
                        <optgroup label="Enums">
                            <For each={dt.enums}>
                                {(en) => <option value={`e:${en.name}`}>{en.name}</option>}
                            </For>
                        </optgroup>
                    </Show>
                </select>
                <Show when={isString()}>
                    <input
                        class="dt-len-input"
                        type="number"
                        min="0"
                        title="Byte length"
                        value={f().length ?? 0}
                        onChange={(e) => dt.updateField(props.structId, f().id, { length: Number(e.currentTarget.value) || 0 })}
                    />
                </Show>
            </div>
            <button class="dt-icon-btn" title="Remove field" onClick={() => dt.removeField(props.structId, f().id)}>×</button>
        </div>
    );
}

function EnumCard(props: { def: EnumDef }) {
    const dt = useDataTypes();
    const e = () => props.def;
    const [seedText, setSeedText] = createSignal("");

    const handleSeed = () => {
        const values = seedText()
            .split(/[\s,]+/)
            .map((t) => (t.startsWith("0x") ? parseInt(t, 16) : Number(t)))
            .filter((n) => Number.isInteger(n));
        if (values.length > 0) dt.seedEnumFromValues(e().id, values);
        setSeedText("");
    };

    return (
        <div class="dt-card">
            <div class="dt-card-head">
                <input
                    class="dt-name-input"
                    value={e().name}
                    onChange={(ev) => dt.renameEnum(e().id, ev.currentTarget.value)}
                />
                <select
                    class="dt-underlying"
                    title="Underlying integer type"
                    value={e().underlying}
                    onChange={(ev) => dt.setEnumUnderlying(e().id, ev.currentTarget.value as PrimitiveTypeId)}
                >
                    <For each={NODE_TYPE_LIST.filter((t) => t.category === "int" || t.category === "uint")}>
                        {(t) => <option value={t.id}>{t.label}</option>}
                    </For>
                </select>
                <button class="dt-btn dt-btn-sm" onClick={() => dt.addEnumMember(e().id)}>+ Member</button>
                <button class="dt-icon-btn" title="Delete enum" onClick={() => dt.removeEnum(e().id)}>×</button>
            </div>

            <For each={e().members}>
                {(m, i) => (
                    <div class="dt-member-row">
                        <input
                            class="dt-field-name"
                            value={m.name}
                            onChange={(ev) => dt.updateEnumMember(e().id, i(), { name: ev.currentTarget.value })}
                        />
                        <span class="dt-eq">=</span>
                        <input
                            class="dt-member-val"
                            type="number"
                            value={m.value}
                            onChange={(ev) => dt.updateEnumMember(e().id, i(), { value: Number(ev.currentTarget.value) || 0 })}
                        />
                        <button class="dt-icon-btn" title="Remove member" onClick={() => dt.removeEnumMember(e().id, i())}>×</button>
                    </div>
                )}
            </For>

            <div class="dt-seed-row">
                <input
                    class="dt-seed-input"
                    placeholder="Seed from observed values, e.g. 0 1 4 0x10"
                    value={seedText()}
                    onInput={(ev) => setSeedText(ev.currentTarget.value)}
                    onKeyDown={(ev) => ev.key === "Enter" && handleSeed()}
                />
                <button class="dt-btn dt-btn-sm" onClick={handleSeed}>Seed</button>
            </div>
        </div>
    );
}

// Byte span of one field, mirroring the store's internal sizing but usable from the view for the
// per-row offset column (top-level fields only; nested struct totals come from dt.sizeOf).
function fieldByteSize(dt: ReturnType<typeof useDataTypes>, f: StructField): number {
    if (f.kind === "primitive") {
        const t = NODE_TYPE_LIST.find((n) => n.id === f.typeId);
        if (!t) return 0;
        return t.category === "string" ? f.length ?? 0 : t.size;
    }
    if (f.kind === "enum") {
        const en = dt.enumByName(f.refName ?? "");
        const u = NODE_TYPE_LIST.find((n) => n.id === (en?.underlying ?? "int32"));
        return u?.size ?? 4;
    }
    const st = dt.structByName(f.refName ?? "");
    return st ? dt.sizeOf(st) : 0;
}
