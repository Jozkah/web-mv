import { createStore, produce } from "solid-js/store";
import { createMemo } from "solid-js";
import { load, persist } from "./persist";
import { NODE_TYPES, type PrimitiveTypeId } from "../views/memory/nodes/types";

// A global registry of user-defined data types: structs (ordered collections of typed fields) and
// enums (named integer constants). It is deliberately independent of any live process or memory
// class - the definitions are pure metadata the user authors once and reuses everywhere. A struct
// field references a memory-node primitive (see views/memory/nodes/types.ts) or, by name, another
// struct/enum in this same registry, so nested layouts compose. Everything here is persisted to
// localStorage (version-tagged) and round-trips through export/import JSON.

export type FieldKind = "primitive" | "struct" | "enum";

/** One field in a struct. `typeId` carries the primitive when kind==="primitive"; `refName` names
 *  the target struct/enum otherwise. `length` is the byte span of a variable-length string field. */
export interface StructField {
    id: string;
    name: string;
    kind: FieldKind;
    typeId: PrimitiveTypeId;
    refName?: string;
    length?: number;
}

export interface StructDef {
    id: string;
    name: string;
    fields: StructField[];
}

export interface EnumMember {
    name: string;
    value: number;
}

/** A named set of integer constants. `underlying` is the primitive the value is stored as, used
 *  only to size the enum when embedded in a struct. */
export interface EnumDef {
    id: string;
    name: string;
    underlying: PrimitiveTypeId;
    members: EnumMember[];
}

interface Registry {
    structs: StructDef[];
    enums: EnumDef[];
}

const STORAGE_KEY = "ax.datatypes";
const STORAGE_VERSION = 1;

const isPrimitive = (id: unknown): id is PrimitiveTypeId =>
    typeof id === "string" && id in NODE_TYPES && NODE_TYPES[id as PrimitiveTypeId].category !== "fill";

// Validate a raw payload (from localStorage or an import file) into a clean Registry. Bad rows are
// dropped one by one rather than discarding the whole set, mirroring annotations.hydrate().
function sanitize(raw: unknown): Registry {
    const out: Registry = { structs: [], enums: [] };
    if (!raw || typeof raw !== "object") return out;
    const r = raw as Partial<Registry>;

    if (Array.isArray(r.structs)) {
        for (const s of r.structs) {
            if (!s || typeof s.name !== "string" || !Array.isArray(s.fields)) continue;
            const fields: StructField[] = [];
            for (const f of s.fields) {
                if (!f || typeof f.name !== "string") continue;
                const kind: FieldKind =
                    f.kind === "struct" || f.kind === "enum" ? f.kind : "primitive";
                if (kind === "primitive" && !isPrimitive(f.typeId)) continue;
                if (kind !== "primitive" && typeof f.refName !== "string") continue;
                fields.push({
                    id: typeof f.id === "string" ? f.id : freshId("fld"),
                    name: f.name,
                    kind,
                    typeId: isPrimitive(f.typeId) ? f.typeId : "int32",
                    refName: typeof f.refName === "string" ? f.refName : undefined,
                    length: typeof f.length === "number" ? f.length : undefined,
                });
            }
            out.structs.push({
                id: typeof s.id === "string" ? s.id : freshId("struct"),
                name: s.name,
                fields,
            });
        }
    }

    if (Array.isArray(r.enums)) {
        for (const e of r.enums) {
            if (!e || typeof e.name !== "string" || !Array.isArray(e.members)) continue;
            const members: EnumMember[] = [];
            for (const m of e.members) {
                if (!m || typeof m.name !== "string" || typeof m.value !== "number") continue;
                members.push({ name: m.name, value: m.value });
            }
            out.enums.push({
                id: typeof e.id === "string" ? e.id : freshId("enum"),
                name: e.name,
                underlying: isPrimitive(e.underlying) ? e.underlying : "int32",
                members,
            });
        }
    }

    return out;
}

let idSeq = Date.now();
function freshId(prefix: string): string {
    idSeq++;
    return `${prefix}_${idSeq.toString(36)}`;
}

export function createDataTypesStore() {
    const [store, setStore] = createStore<Registry>(
        sanitize(load<Registry>(STORAGE_KEY, STORAGE_VERSION)),
    );

    persist(STORAGE_KEY, STORAGE_VERSION, () => ({
        structs: store.structs.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f })) })),
        enums: store.enums.map((e) => ({ ...e, members: e.members.map((m) => ({ ...m })) })),
    }));

    const structByName = (name: string) => store.structs.find((s) => s.name === name);
    const enumByName = (name: string) => store.enums.find((e) => e.name === name);

    // Byte span of a single field. Struct/enum refs are resolved by name; `seen` guards against a
    // cyclic definition so the size walk always terminates (a cycle contributes 0).
    function fieldSize(f: StructField, seen: Set<string>): number {
        if (f.kind === "primitive") {
            const t = NODE_TYPES[f.typeId];
            if (t.category === "string") return f.length ?? 0;
            return t.size;
        }
        if (f.kind === "enum") return NODE_TYPES[enumByName(f.refName ?? "")?.underlying ?? "int32"].size;
        const target = structByName(f.refName ?? "");
        return target ? structSize(target, seen) : 0;
    }

    function structSize(s: StructDef, seen = new Set<string>()): number {
        if (seen.has(s.id)) return 0;
        seen.add(s.id);
        return s.fields.reduce((sum, f) => sum + fieldSize(f, seen), 0);
    }

    return {
        get structs() {
            return store.structs;
        },
        get enums() {
            return store.enums;
        },

        structByName,
        enumByName,

        /** Total byte span of a struct, resolving nested struct/enum references. */
        sizeOf(s: StructDef): number {
            return structSize(s);
        },

        // --- Struct CRUD ---
        addStruct(name = "NewStruct"): string {
            const id = freshId("struct");
            setStore("structs", (list) => [...list, { id, name: uniqueName(name, store.structs), fields: [] }]);
            return id;
        },
        renameStruct(id: string, name: string) {
            setStore("structs", (s) => s.id === id, "name", name.trim() || "unnamed");
        },
        removeStruct(id: string) {
            setStore("structs", (list) => list.filter((s) => s.id !== id));
        },
        addField(structId: string) {
            setStore(
                "structs",
                (s) => s.id === structId,
                "fields",
                (fields) => [
                    ...fields,
                    { id: freshId("fld"), name: `field_${fields.length}`, kind: "primitive", typeId: "int32" } as StructField,
                ],
            );
        },
        updateField(structId: string, fieldId: string, patch: Partial<StructField>) {
            setStore(
                "structs",
                (s) => s.id === structId,
                "fields",
                (f) => f.id === fieldId,
                produce((f: StructField) => {
                    Object.assign(f, patch);
                }),
            );
        },
        removeField(structId: string, fieldId: string) {
            setStore(
                "structs",
                (s) => s.id === structId,
                "fields",
                (fields) => fields.filter((f) => f.id !== fieldId),
            );
        },

        // --- Enum CRUD ---
        addEnum(name = "NewEnum"): string {
            const id = freshId("enum");
            setStore("enums", (list) => [
                ...list,
                { id, name: uniqueName(name, store.enums), underlying: "int32", members: [] },
            ]);
            return id;
        },
        renameEnum(id: string, name: string) {
            setStore("enums", (e) => e.id === id, "name", name.trim() || "unnamed");
        },
        setEnumUnderlying(id: string, underlying: PrimitiveTypeId) {
            setStore("enums", (e) => e.id === id, "underlying", underlying);
        },
        removeEnum(id: string) {
            setStore("enums", (list) => list.filter((e) => e.id !== id));
        },
        addEnumMember(enumId: string, member?: EnumMember) {
            setStore(
                "enums",
                (e) => e.id === enumId,
                "members",
                (members) => [...members, member ?? { name: `MEMBER_${members.length}`, value: members.length }],
            );
        },
        updateEnumMember(enumId: string, index: number, patch: Partial<EnumMember>) {
            setStore(
                "enums",
                (e) => e.id === enumId,
                "members",
                index,
                produce((m: EnumMember) => {
                    Object.assign(m, patch);
                }),
            );
        },
        removeEnumMember(enumId: string, index: number) {
            setStore(
                "enums",
                (e) => e.id === enumId,
                "members",
                (members) => members.filter((_, i) => i !== index),
            );
        },
        /** Seed enum members from a set of observed integer values, skipping any already named. */
        seedEnumFromValues(enumId: string, values: number[]) {
            setStore(
                "enums",
                (e) => e.id === enumId,
                "members",
                produce((members: EnumMember[]) => {
                    const known = new Set(members.map((m) => m.value));
                    for (const v of values) {
                        if (Number.isInteger(v) && !known.has(v)) {
                            known.add(v);
                            members.push({ name: `VALUE_${v}`, value: v });
                        }
                    }
                }),
            );
        },

        /** Format an integer as its enum member name, or `EnumName(value)` when unmatched. */
        formatEnumValue(enumName: string, value: number): string {
            const def = enumByName(enumName);
            if (!def) return String(value);
            const hit = def.members.find((m) => m.value === value);
            return hit ? hit.name : `${enumName}(${value})`;
        },

        // --- Export / import ---
        exportJson(): string {
            return JSON.stringify({ structs: store.structs, enums: store.enums }, null, 2);
        },
        /** Replace the registry from a JSON string. Returns an error message, or null on success. */
        importJson(text: string): string | null {
            try {
                const parsed = sanitize(JSON.parse(text));
                setStore(produce((s) => {
                    s.structs = parsed.structs;
                    s.enums = parsed.enums;
                }));
                return null;
            } catch (e) {
                return e instanceof Error ? e.message : "Invalid JSON";
            }
        },

        counts: createMemo(() => ({ structs: store.structs.length, enums: store.enums.length })),
    };
}

// Ensure a fresh name does not collide with an existing struct/enum, appending _N as needed.
function uniqueName(base: string, existing: { name: string }[]): string {
    const names = new Set(existing.map((x) => x.name));
    if (!names.has(base)) return base;
    let i = 1;
    while (names.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
}

export type DataTypesState = ReturnType<typeof createDataTypesStore>;
