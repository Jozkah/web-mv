import type { TabKind } from "../WorkspaceContext";

// Metadata that drives the "new tab" command menu: label + one-line description per view. Sig
// scan is intentionally absent - it lives as a floating utility window, not a workspace tab, so
// there is a single coherent way to open it.

export interface TabKindMeta {
    kind: TabKind;
    label: string;
    description: string;
}

// Primary views, shown first in the menu.
export const PRIMARY_KINDS: TabKindMeta[] = [
    { kind: "memory", label: "Memory Viewer", description: "Inspect and reconstruct live process memory" },
    { kind: "static", label: "Modules", description: "Functions, disassembly and signatures" },
    { kind: "strings", label: "Strings", description: "Search extracted module strings" },
    { kind: "history", label: "History", description: "Recently visited locations" },
];

// Secondary tools, shown below a divider.
export const SECONDARY_KINDS: TabKindMeta[] = [
    { kind: "analysis", label: "Analysis", description: "Call graph, CFG, prototypes and operand search" },
    { kind: "datatypes", label: "Data Types", description: "Global structs and enums, enum reconstruction" },
    { kind: "cheat", label: "Cheat Table", description: "Pinned addresses and live values" },
    { kind: "pe", label: "PE / Symbols", description: "Module headers and exports" },
    { kind: "bookmarks", label: "Bookmarks", description: "Saved classes and modules" },
    { kind: "diff", label: "Snapshot Diff", description: "Compare two memory snapshots" },
    { kind: "hex", label: "Memory Inspector", description: "Live hex + ASCII with byte editing" },
    { kind: "regions", label: "Memory Map", description: "Live region map with protection flags" },
    { kind: "scanner", label: "Value Scanner", description: "Search memory for a value, then narrow" },
    { kind: "pointer", label: "Pointer Chain", description: "Resolve a base + offset chain live" },
    { kind: "watch", label: "Memory Watch", description: "Poll addresses and track value changes over time" },
    { kind: "patch", label: "Patches", description: "Raw-byte patches with always-reversible originals" },
    { kind: "emulator", label: "Emulator", description: "Offline Unicorn emulation, registers and instruction trace" },
    { kind: "timeline", label: "Timeline", description: "Unified event timeline across all evidence" },
    { kind: "project", label: "Project", description: "Export / import / compare the whole per-target workspace" },
];

export const ALL_MENU_KINDS: TabKindMeta[] = [...PRIMARY_KINDS, ...SECONDARY_KINDS];
