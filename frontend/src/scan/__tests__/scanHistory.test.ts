import { describe, expect, it } from "vitest";
import { branchAt, canRedo, canUndo, emptyHistory, pushStage, redo, replayOps, undo, type ScanHistoryState } from "../scanHistory";

const newStage = (count: number) => ({ kind: "new" as const, valueType: "i32" as const, scope: "module" as const, valueHex: "0x64", count });
const filter = (op: "changed" | "unchanged" | "increased" | "decreased", count: number) => ({ kind: "filter" as const, op, count });

describe("scan history", () => {
    it("a new scan resets history", () => {
        let s: ScanHistoryState = emptyHistory();
        s = pushStage(s, newStage(1000));
        s = pushStage(s, filter("decreased", 40));
        s = pushStage(s, newStage(2000)); // fresh scan
        expect(s.stages).toHaveLength(1);
        expect(s.cursor).toBe(0);
    });

    it("undo/redo move the cursor without losing stages", () => {
        let s = emptyHistory();
        s = pushStage(s, newStage(1000));
        s = pushStage(s, filter("decreased", 40));
        s = pushStage(s, filter("unchanged", 12));
        expect(s.cursor).toBe(2);
        s = undo(s);
        expect(s.cursor).toBe(1);
        expect(canRedo(s)).toBe(true);
        s = redo(s);
        expect(s.cursor).toBe(2);
    });

    it("branching from an earlier stage truncates the forward branch", () => {
        let s = emptyHistory();
        s = pushStage(s, newStage(1000));
        s = pushStage(s, filter("decreased", 40));
        s = pushStage(s, filter("unchanged", 12));
        s = branchAt(s, 1); // go back to after the first filter
        s = pushStage(s, filter("increased", 8)); // new branch
        expect(s.stages.map((x) => (x.kind === "filter" ? x.op : "new"))).toEqual(["new", "decreased", "increased"]);
        expect(s.cursor).toBe(2);
        expect(canRedo(s)).toBe(false);
    });

    it("replayOps returns the ops to reproduce the current candidate set", () => {
        let s = emptyHistory();
        s = pushStage(s, newStage(1000));
        s = pushStage(s, filter("decreased", 40));
        s = pushStage(s, filter("unchanged", 12));
        s = undo(s);
        const ops = replayOps(s);
        expect(ops.map((o) => o.kind)).toEqual(["new", "filter"]);
        expect(canUndo(s)).toBe(true);
    });
});
