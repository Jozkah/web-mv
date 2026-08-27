import { createComputed, createSignal, on, untrack, type Accessor } from "solid-js";
import { NO_TARGET_KEY } from "./workspaceKey";

// Centralized, atomic target-transition authority. Previously the generation bump and the target
// timeline producer both reacted to `liveKey` independently, so correctness depended on Solid effect
// creation order. Here a SINGLE effect computes the whole transition — previous target, new target,
// new generation, and the attach/detach/change classification — as one value. The generation is
// raised synchronously before that value is published, and every consumer reads the generation (or
// the transition's own `generation` field) at read time, so nothing depends on effect ordering.
//
// Late async work started under an old generation stays stale by comparing the captured generation
// against `generation()` when the result returns — again a value comparison, never an effect race.

export interface TargetIdentity {
    key: string;
    pid?: number;
    base?: string;
}

export type TargetTransitionKind = "attach" | "detach" | "change" | "none";

export interface TargetTransition {
    generation: number;
    kind: TargetTransitionKind;
    previous: TargetIdentity;
    current: TargetIdentity;
}

// Pure transition computation — no reactivity, so it is trivially testable. A same-key identity is a
// no-op ("none", generation unchanged). Otherwise the generation advances by one and the kind is
// derived from whether either side is the no-target scratch key.
export function computeTransition(
    previous: TargetIdentity,
    current: TargetIdentity,
    previousGeneration: number,
): TargetTransition {
    if (current.key === previous.key) {
        return { generation: previousGeneration, kind: "none", previous, current };
    }
    const kind: TargetTransitionKind =
        previous.key === NO_TARGET_KEY ? "attach" : current.key === NO_TARGET_KEY ? "detach" : "change";
    return { generation: previousGeneration + 1, kind, previous, current };
}

export function createTargetSession(identity: Accessor<TargetIdentity>) {
    const [generation, setGeneration] = createSignal(0);
    const [transition, setTransition] = createSignal<TargetTransition | null>(null);
    // Seed from the initial identity WITHOUT emitting a transition (boot is not an attach event).
    let prev: TargetIdentity = untrack(identity);

    // createComputed (not createEffect) so the generation + transition settle SYNCHRONOUSLY within
    // the identity-change update, before any downstream effect/async work reads them. This is what
    // makes the transition atomic and effect-order-independent.
    createComputed(
        on(
            identity,
            (cur) => {
                const t = computeTransition(prev, cur, untrack(generation));
                if (t.kind === "none") return;
                setGeneration(t.generation);
                setTransition(t);
                prev = cur;
            },
            { defer: true },
        ),
    );

    return {
        generation,
        transition,
        /** True when a generation captured earlier no longer matches the live one (stale result). */
        isStale: (capturedGeneration: number): boolean => capturedGeneration !== generation(),
    };
}

export type TargetSession = ReturnType<typeof createTargetSession>;
