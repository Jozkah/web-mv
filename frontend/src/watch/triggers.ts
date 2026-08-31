import type { WatchTriggerDefinition, WatchTriggerRuntime } from "./model";

// Pure trigger state machine. A trigger turns a predicate match into a firing decision, honoring
// transition-only vs every-sample firing, a consecutive-match threshold, a cooldown, and one-shot
// mode. No arbitrary code runs here — the caller maps `fire` to the definition's declared actions
// (timeline event, flag, notify, pause). Deterministic and side-effect-free for exhaustive tests.

export function freshTriggerRuntime(): WatchTriggerRuntime {
    return { matchedStreak: 0, wasMeeting: false, triggerCount: 0, firedOnce: false, flagged: false };
}

export interface TriggerEval {
    fire: boolean;
    runtime: WatchTriggerRuntime;
}

export function evaluateTrigger(
    def: WatchTriggerDefinition | undefined,
    runtime: WatchTriggerRuntime,
    predicateMatched: boolean,
    nowMs: number,
): TriggerEval {
    const streak = predicateMatched ? runtime.matchedStreak + 1 : 0;

    if (!def || !def.enabled) {
        return { fire: false, runtime: { ...runtime, matchedStreak: streak, wasMeeting: false } };
    }

    const meets = streak >= Math.max(1, def.consecutive);
    let fire = false;
    if (meets) {
        if (def.everySample) fire = true;
        else if (!runtime.wasMeeting) fire = true; // false → true transition
    }
    // Cooldown suppresses firing but the transition is still considered consumed (wasMeeting = meets).
    if (fire && def.cooldownMs > 0 && runtime.lastTriggerMs !== undefined && nowMs - runtime.lastTriggerMs < def.cooldownMs) {
        fire = false;
    }
    if (fire && def.oneShot && runtime.firedOnce) fire = false;

    return {
        fire,
        runtime: {
            matchedStreak: streak,
            wasMeeting: meets,
            lastTriggerMs: fire ? nowMs : runtime.lastTriggerMs,
            triggerCount: fire ? runtime.triggerCount + 1 : runtime.triggerCount,
            firedOnce: runtime.firedOnce || fire,
            flagged: fire ? true : runtime.flagged,
        },
    };
}

// Manual reset clears streak/flag/one-shot latch but preserves the historical trigger count.
export function resetTriggerRuntime(runtime: WatchTriggerRuntime): WatchTriggerRuntime {
    return { matchedStreak: 0, wasMeeting: false, triggerCount: runtime.triggerCount, firedOnce: false, flagged: false };
}
