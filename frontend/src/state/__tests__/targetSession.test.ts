import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { computeTransition, createTargetSession, type TargetIdentity } from "../targetSession";

const NONE: TargetIdentity = { key: "none" };
const A: TargetIdentity = { key: "pid:100", pid: 100 };
const B: TargetIdentity = { key: "pid:200", pid: 200 };

describe("computeTransition (pure)", () => {
    it("classifies attach / detach / change and advances generation only on change", () => {
        expect(computeTransition(NONE, A, 0)).toMatchObject({ kind: "attach", generation: 1 });
        expect(computeTransition(A, NONE, 1)).toMatchObject({ kind: "detach", generation: 2 });
        expect(computeTransition(A, B, 1)).toMatchObject({ kind: "change", generation: 2 });
        expect(computeTransition(A, A, 5)).toMatchObject({ kind: "none", generation: 5 });
    });
});

describe("createTargetSession", () => {
    it("emits one transition per change, carrying the exact new generation", () => {
        createRoot((dispose) => {
            const [id, setId] = createSignal<TargetIdentity>(NONE);
            const s = createTargetSession(id);
            expect(s.generation()).toBe(0);
            expect(s.transition()).toBeNull();

            setId(A); // attach
            expect(s.generation()).toBe(1);
            expect(s.transition()).toMatchObject({ kind: "attach", generation: 1, current: A });

            setId(B); // change
            expect(s.generation()).toBe(2);
            expect(s.transition()).toMatchObject({ kind: "change", generation: 2, previous: A, current: B });

            setId(NONE); // detach
            expect(s.generation()).toBe(3);
            expect(s.transition()).toMatchObject({ kind: "detach", generation: 3 });
            dispose();
        });
    });

    it("ignores no-op identity writes (no duplicate events, generation stable)", () => {
        createRoot((dispose) => {
            const [id, setId] = createSignal<TargetIdentity>(A);
            const s = createTargetSession(id);
            // Re-setting the same key (e.g. a ping refresh) must not bump generation or emit.
            setId({ key: "pid:100", pid: 100 });
            expect(s.generation()).toBe(0);
            expect(s.transition()).toBeNull();
            dispose();
        });
    });

    it("rapid switches each advance generation and land on the final target", () => {
        createRoot((dispose) => {
            const [id, setId] = createSignal<TargetIdentity>(NONE);
            const s = createTargetSession(id);
            setId(A);
            setId(B);
            setId(A);
            expect(s.generation()).toBe(3);
            expect(s.transition()).toMatchObject({ current: A, generation: 3 });
            dispose();
        });
    });

    it("marks a generation captured before a switch as stale (value compare, not effect order)", () => {
        createRoot((dispose) => {
            const [id, setId] = createSignal<TargetIdentity>(A);
            const s = createTargetSession(id);
            const captured = s.generation(); // a poll cycle captures this at start
            expect(s.isStale(captured)).toBe(false);
            setId(B); // target switches while the read is in flight
            expect(s.isStale(captured)).toBe(true); // late response is stale regardless of effect order
            dispose();
        });
    });
});
