// Normalize an unknown thrown value (catch clauses are typed `unknown`) into something usable.
// errorText pulls a display string; toError keeps a real Error untouched (so its stack survives)
// and only wraps a non-Error throw. Used wherever we catch and surface a failure.

export function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

export function toError(e: unknown): Error {
    return e instanceof Error ? e : new Error(String(e));
}
