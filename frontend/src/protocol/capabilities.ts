// Typed capability contract — the single source of truth for what this workspace can and cannot
// do, and WHY. Every feature renders from a negotiated CapabilityStatus, never from an assumption
// that a backend "probably" supports something. This file is pure (no I/O) so it can be unit-tested
// and imported by any layer.
//
// Support levels (see AGENTS brief / CAPABILITY-AUDIT.md):
//   angel-native      directly supported by a documented Angel socket route / host call.
//   angel-derived     safely built on documented Angel primitives (e.g. polling reads).
//   extension-agent   implemented by the companion AngelScript agent (web_mv_ext_agent.as).
//   optional-sidecar  needs a local sidecar (Ghidra / tshark / capture driver) that may be absent.
//   unavailable       the required primitive does not exist in Angel at all.
//
// A capability's `level` describes HOW it would be provided; `available` (computed by
// negotiateCapabilities) says whether it is live RIGHT NOW given the connected agents/sidecars.
// The two are deliberately separate: an emulator backed by uc:: is `angel-native` yet reports
// `available:false` until the agent actually advertises the verb that drives it.

export type SupportLevel =
    | "angel-native"
    | "angel-derived"
    | "extension-agent"
    | "optional-sidecar"
    | "unavailable";

export type SidecarId = "ghidra" | "tshark" | "capture";

export type CapabilityId =
    | "memory.read"
    | "memory.write"
    | "memory.regions"
    | "memory.watchPolling"
    | "module.enumerate"
    | "module.exports"
    | "signature.scan"
    | "disassembly.zydis"
    | "emulation.unicorn"
    | "scan.value"
    | "scan.pointer"
    | "debug.live"
    | "debug.breakpointsSoftware"
    | "debug.breakpointsHardware"
    | "debug.registers"
    | "debug.threads"
    | "trace.emulated"
    | "trace.live"
    | "hook.native"
    | "decompiler.ghidra"
    | "network.pcapImport"
    | "network.liveCapture"
    | "network.processCorrelation"
    | "patch.rawBytes"
    | "patch.assemble"
    | "patch.allocate"
    | "project.persist"
    | "menu.control";

// How a capability's availability is decided during negotiation.
type Backing =
    | { kind: "core" } // core Echo agent connected (its socket routes are static/known)
    | { kind: "ext"; verb: string } // ext agent connected AND advertises this verb
    | { kind: "derived"; on: CapabilityId } // available iff another capability is
    | { kind: "sidecar"; sidecar: SidecarId } // optional local tool detected
    | { kind: "builtin" } // frontend-only, always available (browser storage etc.)
    | { kind: "none" }; // no Angel primitive exists — always unavailable

export interface CapabilitySpec {
    id: CapabilityId;
    title: string; // user-facing name
    level: SupportLevel;
    backing: Backing;
    // For anything that can be unavailable: the exact missing primitive (machine-readable) and a
    // user-facing explanation. `alternative` points at a supported capability to fall back to.
    missingPrimitive?: string;
    reason?: string;
    alternative?: CapabilityId;
}

// The registry. Order is display order. Keep verb strings in sync with web_mv_ext_agent.as's
// dispatch and the core Angel socket routes (see protocol/messages.ts RequestType).
export const CAPABILITY_SPECS: readonly CapabilitySpec[] = [
    {
        id: "memory.read",
        title: "Memory read",
        level: "angel-native",
        backing: { kind: "core" },
    },
    {
        id: "memory.write",
        title: "Memory write",
        level: "extension-agent",
        backing: { kind: "ext", verb: "write" },
        missingPrimitive: "ext agent verb: write",
        reason: "The companion extension agent (web_mv_ext_agent.as) is not connected.",
    },
    {
        id: "memory.regions",
        title: "Memory regions",
        level: "extension-agent",
        backing: { kind: "ext", verb: "regions" },
        missingPrimitive: "ext agent verb: regions",
        reason: "The companion extension agent is not connected. (Note: this host's memory_region exposes only base/size/protect — MEM_* state/type are reported as 0.)",
    },
    {
        id: "memory.watchPolling",
        title: "Memory watch (polling)",
        level: "angel-derived",
        backing: { kind: "derived", on: "memory.read" },
        reason: "Requires memory reads (core agent).",
    },
    {
        id: "module.enumerate",
        title: "Module list",
        level: "angel-native",
        backing: { kind: "core" },
    },
    {
        id: "module.exports",
        title: "Module exports / imports",
        level: "extension-agent",
        backing: { kind: "ext", verb: "exports" },
        missingPrimitive: "ext agent verb: exports/imports",
        reason: "The companion extension agent is not connected.",
    },
    {
        id: "signature.scan",
        title: "Signature scan",
        level: "angel-native",
        backing: { kind: "core" },
    },
    {
        id: "disassembly.zydis",
        title: "Disassembly (Zydis)",
        level: "angel-native",
        backing: { kind: "core" },
    },
    {
        id: "emulation.unicorn",
        title: "Emulator (Unicorn)",
        level: "angel-native",
        backing: { kind: "ext", verb: "emulate" },
        missingPrimitive: "ext agent verb: emulate (Angel uc:: primitive exists; no verb wired yet)",
        reason: "Angel exposes the Unicorn primitive (uc::), but no emulation verb is wired in the agent yet. This is an emulator, never a live debugger.",
    },
    {
        id: "menu.control",
        title: "Menu control",
        level: "extension-agent",
        backing: { kind: "ext", verb: "ui_list" },
        missingPrimitive: "ext agent verb: ui_list/ui_get/ui_set",
        reason: "The companion extension agent is not connected, or does not advertise the menu-control verb lane.",
    },
    {
        id: "scan.value",
        title: "Value scanner",
        level: "extension-agent",
        backing: { kind: "ext", verb: "scan_new" },
        missingPrimitive: "ext agent verb: scan_new/scan_filter",
        reason: "The companion extension agent is not connected.",
    },
    {
        id: "scan.pointer",
        title: "Pointer-chain scan",
        level: "angel-derived",
        backing: { kind: "derived", on: "memory.read" },
        reason: "Pointer-chain discovery is derived from Angel reads. It builds a bounded pointer map over a scoped region (whole-process maps are impractical over the transport) and reverse-searches for base+offset chains.",
        alternative: "scan.value",
    },
    {
        id: "debug.live",
        title: "Live debugger",
        level: "unavailable",
        backing: { kind: "none" },
        missingPrimitive: "live process debug attach (DebugActiveProcess-equivalent)",
        reason: "Angel attaches for memory access only; it never provides a live debugger. Use the emulator instead.",
        alternative: "emulation.unicorn",
    },
    {
        id: "debug.breakpointsSoftware",
        title: "Software breakpoints",
        level: "unavailable",
        backing: { kind: "none" },
        missingPrimitive: "int3 patch + debug-event exception delivery",
        reason: "Requires a live debugger loop Angel does not provide.",
        alternative: "trace.emulated",
    },
    {
        id: "debug.breakpointsHardware",
        title: "Hardware breakpoints / watchpoints",
        level: "unavailable",
        backing: { kind: "none" },
        missingPrimitive: "DR0–DR7 debug registers via live thread context",
        reason: "Requires live thread-context access Angel does not provide. This is what a real 'find what writes this address' needs.",
        alternative: "trace.emulated",
    },
    {
        id: "debug.registers",
        title: "Live CPU registers",
        level: "unavailable",
        backing: { kind: "none" },
        missingPrimitive: "GetThreadContext-equivalent live thread context",
        reason: "Angel exposes no live thread context. Emulated registers are available in the emulator instead.",
        alternative: "emulation.unicorn",
    },
    {
        id: "debug.threads",
        title: "Live thread enumeration",
        level: "unavailable",
        backing: { kind: "none" },
        missingPrimitive: "thread enumeration (Thread32First-equivalent)",
        reason: "Angel exposes no thread list.",
    },
    {
        id: "trace.emulated",
        title: "Emulated instruction trace",
        level: "angel-native",
        backing: { kind: "ext", verb: "emulate" },
        missingPrimitive: "ext agent verb: emulate (uc::hook_code exists; no verb wired yet)",
        reason: "The Unicorn code-hook primitive exists (uc::hook_code) but the emulation verb is not wired in the agent yet.",
    },
    {
        id: "trace.live",
        title: "Live execution trace",
        level: "unavailable",
        backing: { kind: "none" },
        missingPrimitive: "single-step / branch-trace on the live process",
        reason: "Requires live execution control Angel does not provide. Polling memory can never identify the instruction that wrote a value.",
        alternative: "trace.emulated",
    },
    {
        id: "hook.native",
        title: "Native function hooks",
        level: "unavailable",
        backing: { kind: "none" },
        missingPrimitive: "executable allocation + protection change + instruction relocation",
        reason: "Trampoline hooking needs allocation, protection changes and relocation Angel does not provide. Emulation-only hooks are possible inside the emulator.",
        alternative: "emulation.unicorn",
    },
    {
        id: "decompiler.ghidra",
        title: "Decompiler (Ghidra)",
        level: "optional-sidecar",
        backing: { kind: "sidecar", sidecar: "ghidra" },
        missingPrimitive: "configured Ghidra headless installation",
        reason: "Optional Ghidra headless sidecar is not configured. It decompiles dumps obtained through Angel; Angel remains the dump source.",
    },
    {
        id: "network.pcapImport",
        title: "PCAP import / dissection",
        level: "optional-sidecar",
        backing: { kind: "sidecar", sidecar: "tshark" },
        missingPrimitive: "configured tshark/Wireshark installation",
        reason: "Optional tshark sidecar is not configured. Angel provides no packet dissection.",
    },
    {
        id: "network.liveCapture",
        title: "Live packet capture",
        level: "optional-sidecar",
        backing: { kind: "sidecar", sidecar: "capture" },
        missingPrimitive: "capture driver / backend with authorization",
        reason: "Angel provides no raw packet capture. A verified local capture backend must be installed and authorized.",
        alternative: "network.pcapImport",
    },
    {
        id: "network.processCorrelation",
        title: "Packet ↔ process correlation",
        level: "angel-derived",
        backing: { kind: "none" },
        missingPrimitive: "PID/socket ownership mapping from a capture backend",
        reason: "Requires a capture backend that can prove PID/socket ownership; heuristic timeline correlation only, never causality.",
    },
    {
        id: "patch.rawBytes",
        title: "Raw byte patch",
        level: "extension-agent",
        backing: { kind: "ext", verb: "write" },
        missingPrimitive: "ext agent verb: write",
        reason: "The companion extension agent is not connected.",
    },
    {
        id: "patch.assemble",
        title: "Assemble patch",
        level: "unavailable",
        backing: { kind: "none" },
        missingPrimitive: "an assembler (Zydis disassembles only, it cannot assemble)",
        reason: "No assembler dependency exists. Raw byte / NOP-fill patching is available.",
        alternative: "patch.rawBytes",
    },
    {
        id: "patch.allocate",
        title: "Allocate / code cave",
        level: "unavailable",
        backing: { kind: "none" },
        missingPrimitive: "VirtualAllocEx / VirtualProtectEx-equivalent",
        reason: "Angel provides no allocation or protection-change primitive on the target.",
    },
    {
        id: "project.persist",
        title: "Project persistence",
        level: "angel-derived",
        backing: { kind: "builtin" },
    },
] as const;

const SPEC_BY_ID = new Map<CapabilityId, CapabilitySpec>(CAPABILITY_SPECS.map((s) => [s.id, s]));

export function capabilitySpec(id: CapabilityId): CapabilitySpec {
    const spec = SPEC_BY_ID.get(id);
    if (!spec) throw new Error(`unknown capability id: ${id}`);
    return spec;
}

// --- Negotiation ------------------------------------------------------------

export interface ExtAgentState {
    connected: boolean;
    verbs: readonly string[]; // verbs the ext agent advertises via its `capabilities` reply
    // Whether `verbs` came from the agent's own `capabilities` reply (confirmed) or was ASSUMED from
    // KNOWN_EXT_VERBS because the agent predates the verb / the query failed. Assumed is never
    // presented as equivalent to confirmed.
    confirmed: boolean;
    // Verbs proven unsupported on THIS connection: an assumed verb that returned UnknownType. Scoped
    // to the current connection/generation — never persisted, cleared on reconnect/renegotiation.
    downgraded?: readonly string[];
    protocolVersion?: number;
}

export interface NegotiationState {
    coreConnected: boolean;
    ext: ExtAgentState | null;
    sidecars?: Partial<Record<SidecarId, boolean>>;
}

// How firmly a capability's state is known — the UI renders these distinctly (never collapsing
// `assumed` into `confirmed`):
//   confirmed    backend explicitly reported support (core connected, or ext verb in its reply).
//   assumed      ext connected but the verb list was assumed (older agent); working but unverified.
//   derived      available because another capability is (e.g. watch-polling ← memory.read).
//   unavailable  no primitive, a missing/ downgraded verb, or an absent sidecar with a stated reason.
//   disconnected the backing agent/sidecar simply is not connected yet.
export type CapabilityProvenance = "confirmed" | "assumed" | "derived" | "unavailable" | "disconnected";

export interface CapabilityStatus {
    id: CapabilityId;
    title: string;
    level: SupportLevel;
    available: boolean;
    provenance: CapabilityProvenance;
    // Present only when unavailable: machine-readable missing primitive + user-facing reason.
    missingPrimitive?: string;
    reason?: string;
    alternative?: CapabilityId;
    // Short machine-readable note on the deciding fact, e.g. "ext verb 'write'".
    detail: string;
}

interface Decision {
    available: boolean;
    provenance: CapabilityProvenance;
    detail: string;
}

// Decide availability + provenance of one spec against a resolved lookup of already-decided ids.
function decide(
    spec: CapabilitySpec,
    state: NegotiationState,
    resolved: Map<CapabilityId, Decision>,
): Decision {
    const b = spec.backing;
    switch (b.kind) {
        case "core":
            return state.coreConnected
                ? { available: true, provenance: "confirmed", detail: "core agent" }
                : { available: false, provenance: "disconnected", detail: "core agent" };
        case "ext": {
            const ext = state.ext;
            if (!ext?.connected) return { available: false, provenance: "disconnected", detail: `ext verb '${b.verb}'` };
            if (ext.downgraded?.includes(b.verb))
                return { available: false, provenance: "unavailable", detail: `ext verb '${b.verb}' downgraded (agent returned UnknownType)` };
            if (ext.verbs.includes(b.verb))
                return {
                    available: true,
                    provenance: ext.confirmed ? "confirmed" : "assumed",
                    detail: `ext verb '${b.verb}'${ext.confirmed ? "" : " (assumed)"}`,
                };
            // Connected, verb not offered: definitively unsupported if the list is confirmed, else
            // still unavailable (it was never in the assumed known set either).
            return { available: false, provenance: "unavailable", detail: `ext verb '${b.verb}' not offered` };
        }
        case "derived": {
            const on = resolved.get(b.on);
            if (on?.available) return { available: true, provenance: "derived", detail: `derived from ${b.on}` };
            return {
                available: false,
                provenance: on?.provenance === "disconnected" ? "disconnected" : "unavailable",
                detail: `derived from ${b.on}`,
            };
        }
        case "sidecar": {
            const present = state.sidecars?.[b.sidecar] === true;
            return present
                ? { available: true, provenance: "confirmed", detail: `sidecar '${b.sidecar}'` }
                : { available: false, provenance: "disconnected", detail: `sidecar '${b.sidecar}'` };
        }
        case "builtin":
            return { available: true, provenance: "confirmed", detail: "builtin" };
        case "none":
            return { available: false, provenance: "unavailable", detail: "no Angel primitive" };
    }
}

/**
 * Compute the live availability of every capability from the negotiated agent/sidecar state.
 * Resolves `derived` backings in dependency order (the registry lists dependencies first, but a
 * fixpoint pass keeps it correct regardless of ordering).
 */
export function negotiateCapabilities(state: NegotiationState): Record<CapabilityId, CapabilityStatus> {
    const resolved = new Map<CapabilityId, Decision>();

    // Fixpoint over derived dependencies (at most N passes for N specs; chains here are shallow).
    for (let pass = 0; pass < CAPABILITY_SPECS.length; pass++) {
        let changed = false;
        for (const spec of CAPABILITY_SPECS) {
            if (resolved.has(spec.id)) continue;
            if (spec.backing.kind === "derived" && !resolved.has(spec.backing.on)) continue;
            resolved.set(spec.id, decide(spec, state, resolved));
            changed = true;
        }
        if (!changed) break;
    }

    const out = {} as Record<CapabilityId, CapabilityStatus>;
    for (const spec of CAPABILITY_SPECS) {
        const d = resolved.get(spec.id) ?? decide(spec, state, resolved);
        out[spec.id] = {
            id: spec.id,
            title: spec.title,
            level: spec.level,
            available: d.available,
            provenance: d.provenance,
            detail: d.detail,
            ...(d.available
                ? {}
                : {
                      missingPrimitive: spec.missingPrimitive,
                      reason: spec.reason,
                      alternative: spec.alternative,
                  }),
        };
    }
    return out;
}

// The verbs the current extension agent implements. Used as a fallback when the agent is connected
// but predates the `capabilities` verb (older web_mv_ext_agent.as), so routing still works and the
// UI does not falsely gray-out working features. Keep in sync with web_mv_ext_agent.as dispatch.
export const KNOWN_EXT_VERBS: readonly string[] = [
    "write",
    "dump",
    "exports",
    "imports",
    "iat_rebuild",
    "sections",
    "regions",
    "scan_new",
    "scan_filter",
    "scan_clear",
    "scan_grouped",
    "raw_scan",
    "pe_header",
    "pe_dirs",
    "resource_tree",
];

// Protocol version the frontend understands. The ext agent reports its own; a mismatch is
// surfaced (not fatal) so capability negotiation can degrade instead of silently misbehaving.
// v2 adds the `emulate` verb family.
export const CAPABILITY_PROTOCOL_VERSION = 2;
