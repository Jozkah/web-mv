// Pointer-preview planning: which pointer targets to actually peek this polling cycle. Pure,
// so prioritization / deduplication / budgeting are unit-testable apart from the poll loop.
//
// Modes bound the eligible set ("Expanded only" also honors explicitly selected pointer rows -
// both are direct user intent); the priority order inside the budget is always expanded ->
// selected -> visible -> rest. Several nodes holding the same target cost one read.

import type { PreviewMode } from "../state/viewerSettings";

export interface LivePointer {
    nodeId: string;
    target: string;
}

export interface PreviewPlanInput {
    pointers: readonly LivePointer[];
    mode: PreviewMode;
    /** Max unique targets to read this cycle; <= 0 disables previews entirely. */
    budget: number;
    expandedIds: ReadonlySet<string>;
    selectedIds: ReadonlySet<string>;
    visibleIds: ReadonlySet<string>;
}

export interface PreviewPlan {
    /** Unique target addresses to read, priority-ordered, within budget. */
    targets: string[];
    /** Unique eligible targets this cycle (before the budget cut). */
    eligible: number;
    /** Eligible targets NOT read because the budget was exceeded. */
    skipped: number;
}

export function planPreviews(input: PreviewPlanInput): PreviewPlan {
    const tier = (p: LivePointer): number => {
        if (input.expandedIds.has(p.nodeId)) return 0;
        if (input.selectedIds.has(p.nodeId)) return 1;
        if (input.visibleIds.has(p.nodeId)) return 2;
        return 3;
    };
    const maxTier = input.mode === "all" ? 3 : input.mode === "visible" ? 2 : 1;

    // Unique targets in priority order: a target's rank is the best tier of any node holding it.
    const bestTier = new Map<string, number>();
    for (const p of input.pointers) {
        const t = tier(p);
        if (t > maxTier) continue;
        const cur = bestTier.get(p.target);
        if (cur === undefined || t < cur) bestTier.set(p.target, t);
    }

    const ordered = [...bestTier.entries()].sort((a, b) => a[1] - b[1]).map(([target]) => target);
    const budget = Math.max(0, input.budget);
    const targets = ordered.slice(0, budget);
    return { targets, eligible: ordered.length, skipped: ordered.length - targets.length };
}
