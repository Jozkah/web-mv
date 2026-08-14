import { createStore, produce } from "solid-js/store";
import { load, persist } from "./persist";
import { VALUE_TYPES, type ValueType } from "../views/cheat/valueCodec";

// Shared Cheat Table state, lifted out of the view so any surface (strings, scan results, PE
// exports, snapshot diff) can push an address into it via `add`. The view still owns the live
// read/freeze poll; only the persisted entry list lives here.

export interface CheatEntry {
    id: string;
    address: string;
    type: ValueType;
    desc: string;
    frozen: boolean;
    frozenHex: string; // little-endian bytes re-written each tick while frozen
}

const STORAGE_KEY = "ax.cheat";
const STORAGE_VERSION = 1;

export function normalizeAddr(input: string): string {
    const s = input.trim().replace(/\s+/g, "");
    const hex = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
    return "0x" + hex.toLowerCase();
}

export function isValidAddr(addr: string): boolean {
    return /^0x[0-9a-f]+$/.test(addr);
}

export function createCheatStore() {
    const saved = load<{ entries: CheatEntry[] }>(STORAGE_KEY, STORAGE_VERSION);
    // Clear the frozen target on load: a restored `frozen:true` row must NOT blind-write last
    // session's bytes on the first poll (the process may have restarted / rebased). The freeze
    // toggle is preserved; late-capture re-locks onto the live value after the first good read.
    const [store, setStore] = createStore<{ entries: CheatEntry[] }>({
        entries: (saved?.entries ?? []).map((e) => ({ ...e, frozenHex: "" })),
    });

    // Snapshot must read every persisted leaf, not just the array reference.
    persist(STORAGE_KEY, STORAGE_VERSION, () => ({
        entries: store.entries.map((e) => ({ ...e })),
    }));

    let seq = 0;
    const nextId = (): string => {
        seq++;
        return `cheat_${Date.now().toString(36)}_${seq}`;
    };

    /** Add an entry from a raw address. Returns the new id, or undefined if the address is invalid. */
    const add = (rawAddress: string, type: ValueType = "i32", desc = ""): string | undefined => {
        const address = normalizeAddr(rawAddress);
        if (!isValidAddr(address)) return undefined;
        const id = nextId();
        setStore("entries", (list) => [
            ...list,
            { id, address, type, desc: desc.trim(), frozen: false, frozenHex: "" },
        ]);
        return id;
    };

    const remove = (id: string) => setStore("entries", (l) => l.filter((e) => e.id !== id));

    // Move a row up (dir -1) or down (dir +1) in the table order.
    const move = (id: string, dir: -1 | 1) =>
        setStore(
            produce((s) => {
                const i = s.entries.findIndex((e) => e.id === id);
                const j = i + dir;
                if (i < 0 || j < 0 || j >= s.entries.length) return;
                const [row] = s.entries.splice(i, 1);
                s.entries.splice(j, 0, row);
            }),
        );

    // Changing the type changes the value width; a frozen row's frozenHex is the OLD width, and
    // the freeze poll writes it verbatim (write size = hex length). Clear it so late-capture
    // re-locks at the new width — otherwise we'd keep writing the wrong byte count past the field.
    const setType = (id: string, type: ValueType) =>
        setStore(
            produce((s) => {
                const t = s.entries.find((e) => e.id === id);
                if (!t) return;
                t.type = type;
                if (t.frozen) t.frozenHex = "";
            }),
        );
    const setDesc = (id: string, desc: string) =>
        setStore("entries", (e) => e.id === id, "desc", desc);
    const setFrozenHex = (id: string, hex: string) =>
        setStore("entries", (e) => e.id === id, "frozenHex", hex);

    /** Toggle freeze; `capturedHex` is the current live value to lock onto (undefined = no good read yet). */
    const toggleFreeze = (id: string, capturedHex: string | undefined) => {
        setStore(
            produce((s) => {
                const t = s.entries.find((e) => e.id === id);
                if (!t) return;
                t.frozen = !t.frozen;
                t.frozenHex = t.frozen ? (capturedHex ?? "") : "";
            }),
        );
    };

    const exportJson = (): string =>
        JSON.stringify(store.entries.map((e) => ({ address: e.address, type: e.type, desc: e.desc })), null, 2);

    /** Import entries from exported JSON (appends). Returns how many valid rows were added. */
    const importJson = (text: string): number => {
        const data: unknown = JSON.parse(text);
        if (!Array.isArray(data)) throw new Error("expected a JSON array");
        let added = 0;
        for (const raw of data) {
            if (!raw || typeof raw !== "object") continue;
            const r = raw as Record<string, unknown>;
            const type = VALUE_TYPES.includes(r.type as ValueType) ? (r.type as ValueType) : "i32";
            const id = add(String(r.address ?? ""), type, typeof r.desc === "string" ? r.desc : "");
            if (id !== undefined) added++;
        }
        return added;
    };

    return {
        get entries() {
            return store.entries;
        },
        add,
        remove,
        move,
        setType,
        setDesc,
        setFrozenHex,
        toggleFreeze,
        exportJson,
        importJson,
    };
}

export type CheatStore = ReturnType<typeof createCheatStore>;
