import type { ScanValueType, ScanFilterOp } from "../protocol/types";

// Pure scan-stage history: the ordered list of operations that produced the current candidate set,
// with a cursor for undo/redo and branching. The ext agent holds a single mutable candidate set
// (scan_new + scan_filter mutate it irreversibly), so "undo" is implemented by REPLAYING the op
// sequence from the initial scan_new up to the chosen stage — this module owns that op history and
// tells the store exactly which ops to replay. Deterministic and unit-testable.

export interface NewScanStage {
    kind: "new";
    valueType: ScanValueType;
    scope: "module" | "process";
    module?: string;
    valueHex?: string;
    count: number;
}

export interface FilterScanStage {
    kind: "filter";
    op: ScanFilterOp;
    valueHex?: string;
    count: number;
}

export type ScanStage = NewScanStage | FilterScanStage;

export interface ScanHistoryState {
    stages: ScanStage[];
    cursor: number; // index of the current stage; -1 = empty
}

export function emptyHistory(): ScanHistoryState {
    return { stages: [], cursor: -1 };
}

// Append a stage. A `new` stage always resets history (a fresh first scan). A `filter` from a
// non-tip cursor truncates the abandoned forward branch first (standard undo/redo semantics).
export function pushStage(state: ScanHistoryState, stage: ScanStage): ScanHistoryState {
    if (stage.kind === "new") return { stages: [stage], cursor: 0 };
    const kept = state.stages.slice(0, state.cursor + 1);
    kept.push(stage);
    return { stages: kept, cursor: kept.length - 1 };
}

export function canUndo(state: ScanHistoryState): boolean {
    return state.cursor > 0;
}
export function canRedo(state: ScanHistoryState): boolean {
    return state.cursor >= 0 && state.cursor < state.stages.length - 1;
}

export function undo(state: ScanHistoryState): ScanHistoryState {
    return canUndo(state) ? { ...state, cursor: state.cursor - 1 } : state;
}
export function redo(state: ScanHistoryState): ScanHistoryState {
    return canRedo(state) ? { ...state, cursor: state.cursor + 1 } : state;
}

// Move the cursor to an earlier stage to branch from it (the caller then pushes a new filter, which
// truncates the forward branch). Clamped to a valid index.
export function branchAt(state: ScanHistoryState, index: number): ScanHistoryState {
    if (index < 0 || index >= state.stages.length) return state;
    return { ...state, cursor: index };
}

// The op sequence to replay to reproduce the candidate set at the current cursor: the first `new`
// stage plus every `filter` up to and including the cursor. The store issues scan_new then each
// scan_filter in order.
export function replayOps(state: ScanHistoryState): ScanStage[] {
    if (state.cursor < 0) return [];
    return state.stages.slice(0, state.cursor + 1);
}

export function currentStage(state: ScanHistoryState): ScanStage | undefined {
    return state.cursor >= 0 ? state.stages[state.cursor] : undefined;
}
