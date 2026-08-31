import { describe, expect, it } from "vitest";
import { evaluateTrigger, freshTriggerRuntime, resetTriggerRuntime } from "../triggers";
import type { WatchTriggerDefinition } from "../model";

const trig = (over: Partial<WatchTriggerDefinition> = {}): WatchTriggerDefinition => ({
    enabled: true,
    everySample: false,
    cooldownMs: 0,
    consecutive: 1,
    oneShot: false,
    severity: "info",
    actions: ["timelineEvent"],
    ...over,
});

describe("evaluateTrigger", () => {
    it("fires only on the false→true transition by default", () => {
        let rt = freshTriggerRuntime();
        let r = evaluateTrigger(trig(), rt, true, 0);
        expect(r.fire).toBe(true); // transition
        rt = r.runtime;
        r = evaluateTrigger(trig(), rt, true, 1);
        expect(r.fire).toBe(false); // still matching, no new transition
        rt = r.runtime;
        r = evaluateTrigger(trig(), rt, false, 2); // drop
        rt = r.runtime;
        r = evaluateTrigger(trig(), rt, true, 3); // rises again
        expect(r.fire).toBe(true);
    });

    it("everySample fires each matching sample", () => {
        let rt = freshTriggerRuntime();
        for (let i = 0; i < 3; i++) {
            const r = evaluateTrigger(trig({ everySample: true }), rt, true, i);
            expect(r.fire).toBe(true);
            rt = r.runtime;
        }
    });

    it("requires N consecutive matches", () => {
        const def = trig({ consecutive: 3 });
        let rt = freshTriggerRuntime();
        let r = evaluateTrigger(def, rt, true, 0);
        expect(r.fire).toBe(false);
        rt = r.runtime;
        r = evaluateTrigger(def, rt, true, 1);
        expect(r.fire).toBe(false);
        rt = r.runtime;
        r = evaluateTrigger(def, rt, true, 2);
        expect(r.fire).toBe(true); // third consecutive
    });

    it("respects cooldown", () => {
        const def = trig({ everySample: true, cooldownMs: 100 });
        let rt = freshTriggerRuntime();
        let r = evaluateTrigger(def, rt, true, 0);
        expect(r.fire).toBe(true);
        rt = r.runtime;
        r = evaluateTrigger(def, rt, true, 50); // within cooldown
        expect(r.fire).toBe(false);
        rt = r.runtime;
        r = evaluateTrigger(def, rt, true, 150); // cooldown elapsed
        expect(r.fire).toBe(true);
    });

    it("one-shot fires at most once", () => {
        const def = trig({ everySample: true, oneShot: true });
        let rt = freshTriggerRuntime();
        let r = evaluateTrigger(def, rt, true, 0);
        expect(r.fire).toBe(true);
        rt = r.runtime;
        r = evaluateTrigger(def, rt, true, 1);
        expect(r.fire).toBe(false);
        // reset re-arms it (count preserved)
        rt = resetTriggerRuntime(r.runtime);
        expect(rt.triggerCount).toBe(1);
        r = evaluateTrigger(def, rt, true, 2);
        expect(r.fire).toBe(true);
    });

    it("a disabled trigger never fires but keeps streak neutral", () => {
        const r = evaluateTrigger(trig({ enabled: false }), freshTriggerRuntime(), true, 0);
        expect(r.fire).toBe(false);
    });
});
