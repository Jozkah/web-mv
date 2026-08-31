import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { AxClient } from "../transport/AxClient";
import { AxError } from "../transport/AxClient";
import { ErrorCode } from "../protocol/messages";
import { capabilities as requestCapabilities } from "../protocol/requests";
import {
    CAPABILITY_PROTOCOL_VERSION,
    KNOWN_EXT_VERBS,
    negotiateCapabilities,
    type CapabilityId,
    type CapabilityStatus,
    type NegotiationState,
    type SidecarId,
} from "../protocol/capabilities";

// Owns the capability handshake on the frontend: negotiates the live capability set from the core
// and ext agent connection state, plus the ext agent's advertised verb list. Every gated feature
// reads from here instead of assuming a backend supports something. Pure negotiation lives in
// protocol/capabilities.ts; this store wires it to reactive connection state + the ext verb query,
// and manages per-connection downgrades (an assumed verb proven unsupported at call time).

export interface CapabilitiesDeps {
    coreConnected: Accessor<boolean>;
    extConnected: Accessor<boolean>;
    // Optional sidecar presence (Ghidra / tshark / capture). Wired in later phases; defaults to none.
    sidecars?: Accessor<Partial<Record<SidecarId, boolean>>>;
    // Monotonic target generation. A change means a different attached process — any per-connection
    // downgrades are cleared so a new target renegotiates from scratch (never persisted across gens).
    targetGeneration?: Accessor<number>;
}

// idle: ext down. negotiating: query in flight. ready: verbs CONFIRMED by the agent's reply.
// assumed: ext up but the verb list was assumed (older agent / transient query failure) — never
// treated as equivalent to confirmed.
export type HandshakeState = "idle" | "negotiating" | "ready" | "assumed";

export function createCapabilitiesStore(client: AxClient, deps: CapabilitiesDeps) {
    // Verbs the ext agent advertises. null = not negotiated yet.
    const [extVerbs, setExtVerbs] = createSignal<readonly string[] | null>(null);
    const [extConfirmed, setExtConfirmed] = createSignal(false);
    const [extProtocol, setExtProtocol] = createSignal<number | undefined>(undefined);
    const [handshake, setHandshake] = createSignal<HandshakeState>("idle");
    // Verbs proven unsupported on the CURRENT connection (an assumed verb that returned UnknownType).
    // Scoped to this connection/generation; never persisted; cleared on reconnect + generation change.
    const [downgraded, setDowngraded] = createSignal<readonly string[]>([]);

    // Re-run the verb query each time the ext agent (re)connects; reset everything when it drops.
    // Reconnection therefore always renegotiates from scratch.
    createEffect(
        on(deps.extConnected, (connected) => {
            setDowngraded([]);
            if (!connected) {
                setExtVerbs(null);
                setExtConfirmed(false);
                setExtProtocol(undefined);
                setHandshake("idle");
                return;
            }
            setHandshake("negotiating");
            requestCapabilities(client)
                .then((res) => {
                    setExtVerbs(res.verbs);
                    setExtConfirmed(true);
                    setExtProtocol(res.protocol_version);
                    setHandshake("ready");
                })
                .catch(() => {
                    // Older agent without the verb (UnknownType), or a transient failure (timeout /
                    // network / close): assume the known verb set so working features are not falsely
                    // disabled, but flag as ASSUMED (not confirmed). A transient failure must NOT
                    // permanently classify anything as unsupported — only a call-time UnknownType does.
                    setExtVerbs(KNOWN_EXT_VERBS);
                    setExtConfirmed(false);
                    setExtProtocol(undefined);
                    setHandshake("assumed");
                });
        }),
    );

    // A different target generation clears per-connection downgrades (they must not persist across
    // unrelated targets). The socket/verb list is unchanged, so no re-query is needed.
    if (deps.targetGeneration) {
        createEffect(on(deps.targetGeneration, () => setDowngraded([]), { defer: true }));
    }

    const state = createMemo<NegotiationState>(() => ({
        coreConnected: deps.coreConnected(),
        ext: deps.extConnected()
            ? {
                  connected: true,
                  verbs: extVerbs() ?? KNOWN_EXT_VERBS,
                  confirmed: extConfirmed(),
                  downgraded: downgraded(),
                  protocolVersion: extProtocol(),
              }
            : null,
        sidecars: deps.sidecars?.() ?? {},
    }));

    const statuses = createMemo(() => negotiateCapabilities(state()));

    const protocolMismatch = createMemo(() => {
        const v = extProtocol();
        return v !== undefined && v !== CAPABILITY_PROTOCOL_VERSION;
    });

    // Permanently downgrade a verb for this connection because a live call proved it unsupported.
    // Only call with a definitive UnknownType response — never for timeouts/cancellation/network.
    function reportVerbUnsupported(verb: string): void {
        setDowngraded((cur) => (cur.includes(verb) ? cur : [...cur, verb]));
    }

    // Convenience guard: downgrade only if the error is a definitive UnknownType. Temporary errors
    // (timeout, cancellation, disconnect, any other AxError code) are ignored so a flaky call never
    // classifies a capability as unsupported.
    function reportVerbError(verb: string, error: unknown): boolean {
        if (error instanceof AxError && error.code === ErrorCode.UnknownType) {
            reportVerbUnsupported(verb);
            return true;
        }
        return false;
    }

    return {
        get(id: CapabilityId): CapabilityStatus {
            return statuses()[id];
        },
        available(id: CapabilityId): boolean {
            return statuses()[id].available;
        },
        all(): CapabilityStatus[] {
            return Object.values(statuses());
        },
        availableCount(): number {
            return this.all().filter((c) => c.available).length;
        },
        totalCount(): number {
            return this.all().length;
        },
        handshake,
        extProtocolVersion: extProtocol,
        protocolMismatch,
        downgradedVerbs: downgraded,
        reportVerbUnsupported,
        reportVerbError,
    };
}

export type CapabilitiesStore = ReturnType<typeof createCapabilitiesStore>;
