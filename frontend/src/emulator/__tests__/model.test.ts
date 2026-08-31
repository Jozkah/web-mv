import { describe, expect, it } from "vitest";
import { clampInsnBudget, clampTraceLimit, computeRegisterDeltas, isSupportedRegister, EMU_INSN_BUDGET_MAX } from "../model";

describe("emulator model", () => {
    it("computes changed-only register deltas", () => {
        const before = { rax: "0x1", rbx: "0x2", rip: "0x1000" };
        const after = { rax: "0x9", rbx: "0x2", rip: "0x1004" };
        const d = computeRegisterDeltas(before, after);
        expect(Object.keys(d).sort()).toEqual(["rax", "rip"]);
        expect(d.rax).toEqual({ before: "0x1", after: "0x9" });
    });

    it("emits no deltas when before is missing (first run)", () => {
        expect(Object.keys(computeRegisterDeltas(undefined, { rax: "0x1" }))).toHaveLength(0);
    });

    it("gates supported registers", () => {
        expect(isSupportedRegister("rax")).toBe(true);
        expect(isSupportedRegister("r15")).toBe(true);
        expect(isSupportedRegister("xmm0")).toBe(false);
        expect(isSupportedRegister("cr3")).toBe(false);
    });

    it("clamps budgets to safe bounds", () => {
        expect(clampInsnBudget(0)).toBeGreaterThan(0);
        expect(clampInsnBudget(1e12)).toBe(EMU_INSN_BUDGET_MAX);
        expect(clampTraceLimit(-5)).toBeGreaterThan(0);
    });
});
