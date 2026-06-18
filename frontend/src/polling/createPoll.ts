import { createSignal, createEffect, onCleanup, untrack, type Accessor } from "solid-js";
import { toError } from "../state/errors";

// Interval-driven polling. The agent never pushes; the UI asks on a timer. Polling pauses
// while `enabled` is false and skips a tick while the previous request is still in flight.
//
// The fetcher runs under untrack: whatever reactive state it reads (e.g. the active class)
// must NOT make this poll re-subscribe and re-fire. Only `enabled` drives the schedule;
// callers that want an immediate fetch on some change call refresh() explicitly.

export interface Poll<T> {
    data: Accessor<T | undefined>;
    error: Accessor<Error | undefined>;
    /** Trigger an immediate poll outside the interval. */
    refresh: () => void;
}

export function createPoll<T>(
    fetcher: () => Promise<T>,
    intervalMs: number,
    enabled: Accessor<boolean> = () => true,
): Poll<T> {
    const [data, setData] = createSignal<T>();
    const [error, setError] = createSignal<Error>();
    let inFlight = false;

    const tick = async () => {
        if (inFlight) return;
        inFlight = true;
        try {
            const value = await fetcher();
            setData(() => value);
            setError(undefined);
        } catch (e) {
            setError(toError(e));
        } finally {
            inFlight = false;
        }
    };

    const run = () => void untrack(tick);

    createEffect(() => {
        if (!enabled()) return;
        run();
        const handle = setInterval(run, intervalMs);
        onCleanup(() => clearInterval(handle));
    });

    return { data, error, refresh: run };
}
