// Unicorn emulator model (frontend side). This is an EMULATOR, never a debugger: process-backed
// mode demand-loads pages from the attached process, but execution and state live entirely in
// Unicorn and the target is never modified. Terminology here always says "emulated".

export const EMULATOR_PROTOCOL_VERSION = 1 as const;

export type EmulatorSessionStatus =
    | "idle"
    | "creating"
    | "ready"
    | "running"
    | "paused"
    | "completed"
    | "faulted"
    | "closing"
    | "closed"
    | "stale";

export type EmulatorMode = "process-backed" | "standalone";

// Stop reasons — mirrors the agent's emu_stop_reason strings, plus frontend-only states.
export type EmulatorStopReason =
    | "stop_reached"
    | "instruction_limit"
    | "timeout"
    | "breakpoint"
    | "invalid_instruction"
    | "unmapped_read"
    | "unmapped_write"
    | "unmapped_fetch"
    | "protection_read"
    | "protection_write"
    | "protection_fetch"
    | "unicorn_error"
    | "stale"
    | "trace_limit"
    | "cancelled"
    | "unknown";

// Only the x86-64 registers Angel's uc:: documents for reg_read64/reg_write64 that we expose. SIMD /
// segment / control registers are intentionally omitted this phase.
export const SUPPORTED_REGISTERS = [
    "rax", "rbx", "rcx", "rdx", "rsi", "rdi", "rbp", "rsp", "rip", "eflags",
    "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15",
] as const;
export type RegisterName = (typeof SUPPORTED_REGISTERS)[number];

export function isSupportedRegister(name: string): name is RegisterName {
    return (SUPPORTED_REGISTERS as readonly string[]).includes(name);
}

export type Registers = Partial<Record<string, string>>; // name -> canonical hex string

export interface RegisterDelta {
    before: string;
    after: string;
}

// Diff two register snapshots into changed-only deltas (canonical hex compared as-is; the agent
// always emits the same canonical form so string compare is exact).
export function computeRegisterDeltas(before: Registers | undefined, after: Registers | undefined): Record<string, RegisterDelta> {
    const out: Record<string, RegisterDelta> = {};
    if (!after) return out;
    for (const name of SUPPORTED_REGISTERS) {
        const a = before?.[name];
        const b = after[name];
        if (b === undefined) continue;
        if (a !== undefined && a !== b) out[name] = { before: a, after: b };
    }
    return out;
}

export interface EmulatorError {
    kind: string;
    message: string;
    unicornError?: number;
    at: string;
}

export interface EmulatorSession {
    id: string;
    protocolVersion: typeof EMULATOR_PROTOCOL_VERSION;
    targetGeneration: number;
    mode: EmulatorMode;
    status: EmulatorSessionStatus;
    entryAddress: string;
    currentRip?: string;
    stopAddress?: string;
    createdAt: string;
    instructionCount: number;
    traceDropped: number;
    lastError?: EmulatorError;
    registers: Registers;
    previousRegisters?: Registers;
}

// One emulated instruction. registersChanged is NOT populated per-instruction (the code hook exposes
// only address/size; per-instruction register snapshots would be prohibitively heavy) — register
// deltas are computed at the RUN level instead. bytes are the emulated bytes read from Unicorn.
export interface EmulatedTraceEntry {
    index: number;
    runId: number;
    address: string;
    size?: number;
    bytes?: string;
    disassembly?: string;
    branch?: { kind: "call" | "return" | "jump" | "conditional" | "other"; target?: string; taken?: boolean };
}

export interface EmulatorRunSummary {
    runId: number;
    sessionId: string;
    targetGeneration: number;
    entryRip: string;
    finalRip: string;
    instructionCount: number;
    stopReason: EmulatorStopReason;
    unicornError?: number;
    faultAddress?: string;
    durationUs?: number;
    traceCount: number;
    traceDropped: number;
    registerDeltas: Record<string, RegisterDelta>;
    at: string;
}

// --- limits ---
export const EMU_INSN_BUDGET_DEFAULT = 100000;
export const EMU_INSN_BUDGET_MAX = 5000000;
export const EMU_TIMEOUT_US_DEFAULT = 1000000;
export const EMU_TIMEOUT_US_MAX = 5000000;
export const EMU_TRACE_LIMIT_DEFAULT = 10000;
export const EMU_TRACE_LIMIT_MAX = 200000;
export const EMU_STACK_SIZE_DEFAULT = 0x10000;
export const EMU_MEM_READ_MAX = 0x10000;
export const EMU_BREAKPOINT_MAX = 256;

export function clampInsnBudget(n: number): number {
    if (!Number.isFinite(n) || n <= 0) return EMU_INSN_BUDGET_DEFAULT;
    return Math.min(EMU_INSN_BUDGET_MAX, Math.floor(n));
}
export function clampTraceLimit(n: number): number {
    if (!Number.isFinite(n) || n <= 0) return EMU_TRACE_LIMIT_DEFAULT;
    return Math.min(EMU_TRACE_LIMIT_MAX, Math.floor(n));
}
