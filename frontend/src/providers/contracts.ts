// Typed provider contracts for capabilities that are not implemented in-app: decompilation (Ghidra
// sidecar), network analysis (tshark/capture sidecar), live debugging, and native hooks. These are
// the seams a future optional adapter plugs into — the UI already renders honest unavailable states
// from the capability registry, so wiring an adapter is additive and never changes existing behavior.
// No implementations here; these are contracts only.

export interface DecompiledFunction {
    address: string;
    name?: string;
    signature?: string;
    pseudocode: string;
    provenance: "ghidra";
}

// A future Ghidra headless adapter implements this. It decompiles a dump obtained through Angel and
// maps addresses back to the live target — Angel remains the dump source, Ghidra never attaches.
export interface DecompilerProvider {
    readonly id: "ghidra";
    isConfigured(): boolean;
    decompileModule(input: { module: string; dumpPath: string; base: string }): Promise<DecompiledFunction[]>;
    decompileFunction(input: { address: string }): Promise<DecompiledFunction | undefined>;
}

export interface PcapPacketSummary {
    index: number;
    timestamp: string;
    protocol: string;
    source: string;
    destination: string;
    length: number;
    info?: string;
}

// PCAP import/dissection via tshark structured output. Live capture is a separate, more privileged
// capability and is deliberately NOT part of this import-only contract.
export interface NetworkPcapProvider {
    readonly id: "tshark";
    isConfigured(): boolean;
    importPcap(input: { path: string; displayFilter?: string }): Promise<PcapPacketSummary[]>;
}

export type DebugRegisterFile = Record<string, string>;
export interface DebugThread {
    id: number;
    name?: string;
    suspended: boolean;
}
export interface DebugBreakpoint {
    id: string;
    address: string;
    kind: "software" | "hardware";
    enabled: boolean;
    hitCount: number;
}

// A future live-debugger adapter (an explicit, authorized dependency — NOT Angel) would implement
// this. Angel exposes no live thread context / breakpoints / stepping, so no in-app implementation
// exists; the workspace shows the exact missing primitive until an adapter is provided.
export interface DebuggerProvider {
    readonly id: string;
    attach(pid: number): Promise<void>;
    detach(): Promise<void>;
    threads(): Promise<DebugThread[]>;
    readRegisters(threadId: number): Promise<DebugRegisterFile>;
    setBreakpoint(address: string, kind: "software" | "hardware"): Promise<DebugBreakpoint>;
    removeBreakpoint(id: string): Promise<void>;
    continue(): Promise<void>;
    step(threadId: number): Promise<void>;
    pause(): Promise<void>;
}

export interface HookDefinition {
    id: string;
    address: string;
    name: string;
    enabled: boolean;
}

// Native function hooks require executable allocation + protection changes + instruction relocation,
// none of which Angel provides. Emulation-only hooks live inside the emulator (uc::hook_code) and are
// labelled as such. This contract exists for a future, safely-verified hooking adapter.
export interface HookProvider {
    readonly id: string;
    isSupported(): boolean;
    install(def: HookDefinition): Promise<void>;
    remove(id: string): Promise<void>;
}
