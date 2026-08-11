import { createStore, produce } from "solid-js/store";
import { load, persist } from "./persist";

export type HistoryCategory = "function" | "scan" | "memory" | "string_scan";

export interface BaseHistoryItem {
    id: string;
    timestamp: number;
}

export interface FunctionHistoryItem extends BaseHistoryItem {
    type: "function";
    module: string;
    rva: string;
    address: string;
    name?: string;
    size?: number;
}

export interface ScanHistoryItem extends BaseHistoryItem {
    type: "scan";
    kind: "sig";
    pattern: string;
    scope: string;
    findAll: boolean;
    relOffset?: number;
    instLen?: number;
    hitCount: number;
}

export interface MemoryHistoryItem extends BaseHistoryItem {
    type: "memory";
    classId: string;
    className: string;
    address: string;
}

export interface StringScanHistoryItem extends BaseHistoryItem {
    type: "string_scan";
    module: string;
    stringCount: number;
}

export type HistoryItem =
    | FunctionHistoryItem
    | ScanHistoryItem
    | MemoryHistoryItem
    | StringScanHistoryItem;

const STORAGE_KEY = "ax.history";
const STORAGE_VERSION = 1;
const MAX_HISTORY_ITEMS = 200;

interface SavedState {
    items: HistoryItem[];
}

function hydrate(): HistoryItem[] | undefined {
    const saved = load<SavedState>(STORAGE_KEY, STORAGE_VERSION);
    if (!saved || !Array.isArray(saved.items)) return undefined;
    return saved.items;
}

export function createHistoryStore() {
    const initialItems = hydrate() ?? [];
    const [store, setStore] = createStore<{ items: HistoryItem[] }>({ items: initialItems });

    persist(STORAGE_KEY, STORAGE_VERSION, () => ({ items: store.items }));

    let seq = Date.now();
    const nextId = () => `h_${++seq}_${Math.random().toString(36).slice(2, 6)}`;

    function pushItem(item: HistoryItem, matchFn: (existing: HistoryItem) => boolean) {
        setStore(
            produce((s) => {
                // Remove existing duplicate if present (MRU)
                const existingIdx = s.items.findIndex(matchFn);
                if (existingIdx !== -1) {
                    s.items.splice(existingIdx, 1);
                }
                // Prepend new item
                s.items.unshift(item);
                // Cap total items
                if (s.items.length > MAX_HISTORY_ITEMS) {
                    s.items.length = MAX_HISTORY_ITEMS;
                }
            }),
        );
    }

    return {
        get items() {
            return store.items;
        },

        addFunction(payload: Omit<FunctionHistoryItem, "id" | "timestamp" | "type">) {
            const item: FunctionHistoryItem = {
                ...payload,
                type: "function",
                id: nextId(),
                timestamp: Date.now(),
            };
            pushItem(
                item,
                (ex) =>
                    ex.type === "function" &&
                    ex.module.toLowerCase() === payload.module.toLowerCase() &&
                    (ex.rva === payload.rva || ex.address === payload.address),
            );
        },

        addScan(payload: Omit<ScanHistoryItem, "id" | "timestamp" | "type">) {
            const item: ScanHistoryItem = {
                ...payload,
                type: "scan",
                id: nextId(),
                timestamp: Date.now(),
            };
            pushItem(
                item,
                (ex) =>
                    ex.type === "scan" &&
                    ex.kind === payload.kind &&
                    ex.pattern === payload.pattern &&
                    ex.scope === payload.scope,
            );
        },

        addMemory(payload: Omit<MemoryHistoryItem, "id" | "timestamp" | "type">) {
            const item: MemoryHistoryItem = {
                ...payload,
                type: "memory",
                id: nextId(),
                timestamp: Date.now(),
            };
            pushItem(
                item,
                (ex) =>
                    ex.type === "memory" &&
                    (ex.classId === payload.classId || (payload.address !== "" && ex.address === payload.address)),
            );
        },

        addStringScan(payload: Omit<StringScanHistoryItem, "id" | "timestamp" | "type">) {
            const item: StringScanHistoryItem = {
                ...payload,
                type: "string_scan",
                id: nextId(),
                timestamp: Date.now(),
            };
            pushItem(
                item,
                (ex) => ex.type === "string_scan" && ex.module.toLowerCase() === payload.module.toLowerCase(),
            );
        },

        removeItem(id: string) {
            setStore("items", (items) => items.filter((it) => it.id !== id));
        },

        clearAll() {
            setStore("items", []);
        },
    };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
