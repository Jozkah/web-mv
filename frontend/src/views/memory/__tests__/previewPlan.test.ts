import { describe, expect, it } from "vitest";
import { planPreviews, type PreviewPlanInput } from "../nodes/previewPlan";

// Pointer-preview planning: eligibility per mode, expanded > selected > visible priority,
// target deduplication, and the per-cycle budget with its skipped count.

const input = (over: Partial<PreviewPlanInput>): PreviewPlanInput => ({
    pointers: [],
    mode: "all",
    budget: 16,
    expandedIds: new Set(),
    selectedIds: new Set(),
    visibleIds: new Set(),
    ...over,
});

describe("planPreviews", () => {
    it("prioritizes expanded, then selected, then visible pointers", () => {
        const plan = planPreviews(
            input({
                pointers: [
                    { nodeId: "vis", target: "0x3" },
                    { nodeId: "sel", target: "0x2" },
                    { nodeId: "exp", target: "0x1" },
                    { nodeId: "rest", target: "0x4" },
                ],
                expandedIds: new Set(["exp"]),
                selectedIds: new Set(["sel"]),
                visibleIds: new Set(["vis"]),
                budget: 3,
            }),
        );
        expect(plan.targets).toEqual(["0x1", "0x2", "0x3"]);
        expect(plan.eligible).toBe(4);
        expect(plan.skipped).toBe(1);
    });

    it("deduplicates nodes sharing a target - one read per address", () => {
        const plan = planPreviews(
            input({
                pointers: [
                    { nodeId: "a", target: "0x1000" },
                    { nodeId: "b", target: "0x1000" },
                    { nodeId: "c", target: "0x2000" },
                ],
            }),
        );
        expect(plan.targets).toEqual(["0x1000", "0x2000"]);
        expect(plan.eligible).toBe(2);
        expect(plan.skipped).toBe(0);
    });

    it("a shared target takes the best tier of any node holding it", () => {
        const plan = planPreviews(
            input({
                pointers: [
                    { nodeId: "hidden", target: "0x1000" }, // tier 3
                    { nodeId: "exp", target: "0x1000" }, // tier 0 - promotes the target
                    { nodeId: "vis", target: "0x2000" },
                ],
                expandedIds: new Set(["exp"]),
                visibleIds: new Set(["vis"]),
                budget: 1,
            }),
        );
        expect(plan.targets).toEqual(["0x1000"]);
        expect(plan.skipped).toBe(1);
    });

    it("mode 'expanded' includes only expanded and selected pointers", () => {
        const plan = planPreviews(
            input({
                mode: "expanded",
                pointers: [
                    { nodeId: "exp", target: "0x1" },
                    { nodeId: "sel", target: "0x2" },
                    { nodeId: "vis", target: "0x3" },
                    { nodeId: "rest", target: "0x4" },
                ],
                expandedIds: new Set(["exp"]),
                selectedIds: new Set(["sel"]),
                visibleIds: new Set(["vis"]),
            }),
        );
        expect(plan.targets).toEqual(["0x1", "0x2"]);
        expect(plan.eligible).toBe(2);
    });

    it("mode 'visible' adds visible pointers but not off-screen ones", () => {
        const plan = planPreviews(
            input({
                mode: "visible",
                pointers: [
                    { nodeId: "vis", target: "0x3" },
                    { nodeId: "rest", target: "0x4" },
                ],
                visibleIds: new Set(["vis"]),
            }),
        );
        expect(plan.targets).toEqual(["0x3"]);
    });

    it("mode 'all' includes everything", () => {
        const plan = planPreviews(
            input({
                mode: "all",
                pointers: [
                    { nodeId: "a", target: "0x1" },
                    { nodeId: "b", target: "0x2" },
                ],
            }),
        );
        expect(plan.targets).toEqual(["0x1", "0x2"]);
    });

    it("budget 0 disables previews and reports every eligible target as skipped", () => {
        const plan = planPreviews(
            input({
                budget: 0,
                pointers: [
                    { nodeId: "a", target: "0x1" },
                    { nodeId: "b", target: "0x2" },
                ],
            }),
        );
        expect(plan.targets).toEqual([]);
        expect(plan.skipped).toBe(2);
    });
});
