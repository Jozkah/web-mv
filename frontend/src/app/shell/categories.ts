import type { TabKind } from "../WorkspaceContext";

// The five activity categories that group every workspace view. The activity rail renders one
// item per category; the contextual sidebar lists that category's views. `primary` is the view a
// single click on the rail item opens/focuses. Icon names resolve against workspace/icons.tsx.

export type CategoryId = "inspect" | "search" | "analyze" | "modify" | "organize";

export interface CategoryView {
    kind: TabKind;
    label: string;
    hint: string;
}

export interface Category {
    id: CategoryId;
    label: string;
    icon: "inspect" | "search-cat" | "analyze" | "modify" | "organize";
    /** View opened when the rail item itself is activated. */
    primary: TabKind;
    views: CategoryView[];
}

export const CATEGORIES: Category[] = [
    {
        id: "inspect",
        label: "Inspect",
        icon: "inspect",
        primary: "memory",
        views: [
            { kind: "memory", label: "Memory Viewer", hint: "Reconstruct live process memory" },
            { kind: "hex", label: "Memory Inspector", hint: "Live hex + ASCII with byte editing" },
            { kind: "regions", label: "Memory Map", hint: "Region map with protection flags" },
            { kind: "pe", label: "PE / Symbols", hint: "Module headers and exports" },
        ],
    },
    {
        id: "search",
        label: "Search",
        icon: "search-cat",
        primary: "strings",
        views: [
            { kind: "strings", label: "Strings", hint: "Search extracted module strings" },
            { kind: "scanner", label: "Value Scanner", hint: "Search memory for a value, then narrow" },
            { kind: "sigscan", label: "Signature Scan", hint: "Scan a module for an IDA pattern" },
            { kind: "pointer", label: "Pointer Chain", hint: "Resolve a base + offset chain live" },
        ],
    },
    {
        id: "analyze",
        label: "Analyze",
        icon: "analyze",
        primary: "static",
        views: [
            { kind: "static", label: "Modules / Disassembly", hint: "Functions, disassembly, signatures" },
            { kind: "analysis", label: "Analysis", hint: "Call graph, CFG, operand search" },
            { kind: "diff", label: "Snapshot Diff", hint: "Compare two memory snapshots" },
            { kind: "datatypes", label: "Data Types", hint: "Global structs and enums" },
        ],
    },
    {
        id: "modify",
        label: "Modify",
        icon: "modify",
        primary: "cheat",
        views: [{ kind: "cheat", label: "Cheat Table", hint: "Pinned addresses, write and freeze" }],
    },
    {
        id: "organize",
        label: "Organize",
        icon: "organize",
        primary: "bookmarks",
        views: [
            { kind: "bookmarks", label: "Bookmarks", hint: "Saved classes and modules" },
            { kind: "history", label: "History", hint: "Recently visited locations" },
        ],
    },
];

// Which category a given tab kind belongs to (for reflecting the active tab back onto the rail).
const KIND_TO_CATEGORY = new Map<TabKind, CategoryId>();
for (const c of CATEGORIES) {
    for (const v of c.views) KIND_TO_CATEGORY.set(v.kind, c.id);
}
export function categoryForKind(kind: TabKind | undefined): CategoryId | undefined {
    return kind ? KIND_TO_CATEGORY.get(kind) : undefined;
}

export function categoryById(id: CategoryId): Category {
    return CATEGORIES.find((c) => c.id === id)!;
}
