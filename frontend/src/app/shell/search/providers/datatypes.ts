import { loadRaw } from "../../../../state/persist";
import type { SearchProvider, SearchResult } from "../types";
import { paletteStores } from "../stores";

// Data types (structs / enums). The data-types store is constructed ad-hoc in its view rather than
// shared through a context, so there is no live handle to read from the palette. Instead we read the
// persisted snapshot (best-effort, shape-checked) so names stay searchable. Selecting a result opens
// the Data Types view (a precise per-definition jump would need a shared store to target).

interface PersistedField {
    name?: string;
}
interface PersistedStruct {
    id?: string;
    name?: string;
    fields?: PersistedField[];
}
interface PersistedEnumMember {
    name?: string;
}
interface PersistedEnum {
    id?: string;
    name?: string;
    members?: PersistedEnumMember[];
}
interface PersistedDataTypes {
    structs?: PersistedStruct[];
    enums?: PersistedEnum[];
}

function readPersisted(): PersistedDataTypes {
    const raw = loadRaw("ax.datatypes");
    const data = raw?.data;
    if (!data || typeof data !== "object") return {};
    const d = data as PersistedDataTypes;
    return { structs: Array.isArray(d.structs) ? d.structs : [], enums: Array.isArray(d.enums) ? d.enums : [] };
}

export const dataTypesProvider: SearchProvider = {
    id: "datatypes",
    group: "Types",
    scopes: ["type", "field"],
    emptyResults: false,
    maxResults: 40,
    search(_q, ctx) {
        const s = paletteStores(ctx);
        const open = () => s.ws.openOrFocusView("datatypes");
        const { structs = [], enums = [] } = readPersisted();
        const out: SearchResult[] = [];

        for (const st of structs) {
            if (!st.name) continue;
            const fieldNames = (st.fields ?? []).map((f) => f.name).filter(Boolean).join(" ");
            out.push({
                id: `struct:${st.id ?? st.name}`,
                providerId: "datatypes",
                group: "Types",
                title: st.name,
                subtitle: `struct · ${(st.fields ?? []).length} field(s)`,
                icon: "datatypes",
                keywords: `struct type ${st.name} ${fieldNames}`,
                defaultAction: { id: "open", label: "Open in Data Types", run: open },
            });
        }
        for (const en of enums) {
            if (!en.name) continue;
            const memberNames = (en.members ?? []).map((m) => m.name).filter(Boolean).join(" ");
            out.push({
                id: `enum:${en.id ?? en.name}`,
                providerId: "datatypes",
                group: "Types",
                title: en.name,
                subtitle: `enum · ${(en.members ?? []).length} member(s)`,
                icon: "datatypes",
                keywords: `enum type ${en.name} ${memberNames}`,
                defaultAction: { id: "open", label: "Open in Data Types", run: open },
            });
        }
        return out;
    },
};
