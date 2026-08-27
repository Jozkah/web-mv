import { createEffect, on, type Accessor } from "solid-js";
import type { ConnectionStatus } from "../transport/connection";
import type { ModulesStatus } from "../state/modulesStore";
import type { ModuleEntry } from "../protocol/types";
import type { HandshakeState } from "../state/capabilitiesStore";
import type { TargetTransition } from "../state/targetSession";
import { TimelineEventType } from "./events";
import type { TimelineStore } from "./timelineStore";

// Wire the timeline to activity the repository ALREADY supports through Angel: relay/agent
// connection lifecycle, target attach/detach + generation, module-list loads, and the capability
// handshake. Nothing here implies debugging/tracing/hooking/capture — those producers arrive with
// their own phases. Each producer emits only on a real transition (defer), plus one session-start
// marker, so the timeline never fabricates activity.

export interface TimelineProducerDeps {
    relayStatus: Accessor<ConnectionStatus>;
    coreConnected: Accessor<boolean>;
    extConnected: Accessor<boolean>;
    attached: Accessor<boolean>;
    pid: Accessor<number | undefined>;
    base: Accessor<string | undefined>;
    processName: Accessor<string | undefined>;
    // The atomic transition value — carries its own generation, so no reliance on effect order.
    targetTransition: Accessor<TargetTransition | null>;
    targetGeneration: Accessor<number>;
    modulesStatus: Accessor<ModulesStatus>;
    modulesList: Accessor<readonly ModuleEntry[]>;
    handshake: Accessor<HandshakeState>;
    availableCapabilities: Accessor<number>;
    totalCapabilities: Accessor<number>;
    downgradedVerbs: Accessor<readonly string[]>;
}

export function createTimelineProducers(deps: TimelineProducerDeps, timeline: TimelineStore): void {
    // Session marker so an exported timeline always has a zero point.
    timeline.ingest({
        type: TimelineEventType.SessionStart,
        source: "session",
        severity: "info",
        summary: "Session started",
        confidence: "exact",
        provenance: "producer:session",
    });

    // Relay socket lifecycle.
    createEffect(
        on(
            deps.relayStatus,
            (status) => {
                const severity = status === "open" ? "info" : status === "connecting" ? "notice" : "warning";
                timeline.ingest({
                    type: TimelineEventType.RelayStatus,
                    source: "relay",
                    severity,
                    summary: `Relay ${status}`,
                    provenance: "producer:relay",
                    details: { status },
                });
            },
            { defer: true },
        ),
    );

    // Core Echo agent connection (decides angel-native capabilities).
    createEffect(
        on(
            deps.coreConnected,
            (up) =>
                timeline.ingest({
                    type: TimelineEventType.AgentCoreStatus,
                    source: "agent",
                    severity: up ? "info" : "warning",
                    summary: up ? "Core agent connected" : "Core agent disconnected",
                    provenance: "producer:agent",
                    details: { connected: up },
                }),
            { defer: true },
        ),
    );

    // Extension agent connection (write-family verbs).
    createEffect(
        on(
            deps.extConnected,
            (up) =>
                timeline.ingest({
                    type: TimelineEventType.AgentExtStatus,
                    source: "agent",
                    severity: up ? "info" : "notice",
                    summary: up ? "Extension agent connected" : "Extension agent disconnected",
                    provenance: "producer:agent",
                    details: { connected: up },
                }),
            { defer: true },
        ),
    );

    // Target attach/detach/change. Driven by the atomic transition value, which carries the exact
    // generation assigned by the transition — so the event's generation is authoritative and there
    // is no dependence on effect order, and no duplicate events. The timeline's own generation is
    // set from the transition too, before the event is stamped.
    createEffect(
        on(
            deps.targetTransition,
            (t) => {
                if (!t || t.kind === "none") return;
                timeline.setGeneration(t.generation);
                if (t.kind === "detach") {
                    timeline.ingest({
                        type: TimelineEventType.TargetDetached,
                        source: "target",
                        severity: "notice",
                        summary: "Target detached",
                        targetGeneration: t.generation,
                        provenance: "producer:target",
                        details: { generation: t.generation, previous: t.previous.key },
                    });
                    return;
                }
                const name = deps.processName();
                const pid = deps.pid();
                const label = name ?? t.current.key;
                timeline.ingest({
                    type: t.kind === "attach" ? TimelineEventType.TargetAttached : TimelineEventType.TargetGeneration,
                    source: "target",
                    severity: "info",
                    summary:
                        t.kind === "attach"
                            ? `Attached to ${label}${pid !== undefined ? ` (pid ${pid})` : ""}`
                            : `Target changed to ${label}${pid !== undefined ? ` (pid ${pid})` : ""}`,
                    processId: pid,
                    targetGeneration: t.generation,
                    module: deps.base() ? { name: label, base: deps.base() } : undefined,
                    provenance: "producer:target",
                    details: { key: t.current.key, generation: t.generation, kind: t.kind },
                });
            },
            { defer: true },
        ),
    );

    // Module list loaded (Angel `modules`).
    createEffect(
        on(
            deps.modulesStatus,
            (status) => {
                if (status !== "ready") return;
                const count = deps.modulesList().length;
                timeline.ingest({
                    type: TimelineEventType.ModuleListLoaded,
                    source: "module",
                    severity: "debug",
                    summary: `Module list loaded (${count} modules)`,
                    provenance: "producer:module",
                    details: { count },
                });
            },
            { defer: true },
        ),
    );

    // Capability handshake completed (confirmed vs assumed).
    createEffect(
        on(
            deps.handshake,
            (state) => {
                if (state !== "ready" && state !== "assumed") return;
                timeline.ingest({
                    type: TimelineEventType.CapabilityNegotiated,
                    source: "capability",
                    severity: state === "assumed" ? "notice" : "info",
                    summary:
                        state === "assumed"
                            ? `Capabilities assumed (older agent): ${deps.availableCapabilities()}/${deps.totalCapabilities()} available`
                            : `Capabilities confirmed: ${deps.availableCapabilities()}/${deps.totalCapabilities()} available`,
                    confidence: state === "assumed" ? "heuristic" : "exact",
                    provenance: "producer:capability",
                    details: { handshake: state },
                });
            },
            { defer: true },
        ),
    );

    // A verb downgraded at call time (assumed → proven unsupported).
    createEffect(
        on(
            deps.downgradedVerbs,
            (verbs, prev) => {
                const before = new Set(prev ?? []);
                for (const v of verbs) {
                    if (before.has(v)) continue;
                    timeline.ingest({
                        type: TimelineEventType.CapabilityDowngraded,
                        source: "capability",
                        severity: "warning",
                        summary: `Verb '${v}' downgraded: agent returned UnknownType`,
                        provenance: "producer:capability",
                        details: { verb: v },
                    });
                }
            },
            { defer: true },
        ),
    );
}
