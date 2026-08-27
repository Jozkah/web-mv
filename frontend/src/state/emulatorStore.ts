import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { AxClient } from "../transport/AxClient";
import { AxError } from "../transport/AxClient";
import { ErrorCode } from "../protocol/messages";
import { emulate } from "../protocol/requests";
import type { EmulateResult, EmulateRequest, ModuleEntry } from "../protocol/types";
import type { TimelineStore } from "../timeline/timelineStore";
import type { CapabilitiesStore } from "./capabilitiesStore";
import type { TargetSession } from "../state/targetSession";
import { TimelineEventType, jsonDetails, type TimelineEventInput } from "../timeline/events";
import { createTraceStore } from "../emulator/traceStore";
import {
    EMULATOR_PROTOCOL_VERSION,
    clampInsnBudget,
    clampTraceLimit,
    computeRegisterDeltas,
    isSupportedRegister,
    type EmulatedTraceEntry,
    type EmulatorError,
    type EmulatorMode,
    type EmulatorRunSummary,
    type EmulatorSession,
    type EmulatorStopReason,
    type Registers,
} from "../emulator/model";

// Emulator store: the integration hub for the Unicorn emulator. Owns one session at a time, gates on
// the negotiated `emulation.unicorn` capability, binds every session to the target generation used at
// creation, discards stale results, serializes operations, and emits honest `source:"emulator"`
// timeline events. It is an emulator — never presents emulated state as target-process behavior.

const RUN_TIMEOUT_MS = 12000; // generous client ceiling; the agent hard-caps actual execution

export interface EmulatorStoreDeps {
    client: AxClient;
    timeline: TimelineStore;
    capabilities: CapabilitiesStore;
    modules: Accessor<readonly ModuleEntry[]>;
    coreConnected: Accessor<boolean>;
    extConnected: Accessor<boolean>;
    attached: Accessor<boolean>;
    targetSession: TargetSession;
}

export interface CreateSessionInput {
    mode?: EmulatorMode;
    entryAddress: string;
    stopAddress?: string;
    stackBase?: string;
    stackSize?: number;
    initialRegisters?: Registers;
    breakpoints?: string[];
    trace?: boolean;
}

export interface RunInput {
    instructionBudget?: number;
    timeoutUs?: number;
    traceLimit?: number;
    stopAddress?: string;
}

export type EmulatorAvailability = "available" | "assumed" | "unavailable" | "disconnected";

export function createEmulatorStore(deps: EmulatorStoreDeps) {
    const trace = createTraceStore();
    const [session, setSession] = createSignal<EmulatorSession | null>(null);
    const [busy, setBusy] = createSignal(false);
    const [lastError, setLastError] = createSignal<EmulatorError | undefined>();
    let seq = 0;
    let runSeq = 0;

    const nowIso = () => new Date().toISOString();
    const capStatus = createMemo(() => deps.capabilities.get("emulation.unicorn"));
    const traceCapAvailable = createMemo(() => deps.capabilities.available("trace.emulated"));

    const availability = createMemo<EmulatorAvailability>(() => {
        if (!deps.extConnected()) return "disconnected";
        const s = capStatus();
        if (!s.available) return "unavailable";
        return s.provenance === "assumed" ? "assumed" : "available";
    });

    const emit = (input: TimelineEventInput) => deps.timeline.ingest(input);
    const emuEvent = (type: string, severity: TimelineEventInput["severity"], summary: string, details?: Record<string, unknown>): TimelineEventInput => ({
        type,
        source: "emulator",
        severity,
        summary,
        provenance: "Angel Unicorn emulation",
        confidence: "exact",
        targetGeneration: deps.targetSession.generation(),
        tags: ["emulator"],
        details: details ? jsonDetails(details) : undefined,
    });

    function err(kind: string, message: string, unicornError?: number): EmulatorError {
        const e: EmulatorError = { kind, message, unicornError, at: nowIso() };
        setLastError(e);
        return e;
    }

    // Guard: capability + a single in-flight op. Returns an error string, or null when ok to proceed.
    function guard(needSession: boolean): EmulatorError | null {
        if (!deps.extConnected()) return err("extensionDisconnected", "Extension agent is not connected");
        if (availability() === "unavailable") return err("capabilityUnavailable", "emulation.unicorn is not available (agent lacks the emulate verb)");
        if (busy()) return err("busy", "An emulator operation is already in flight");
        if (needSession) {
            const s = session();
            if (!s) return err("invalidSession", "No emulator session");
            if (s.status === "closed" || s.status === "closing") return err("invalidSession", "Session is closed");
            if (s.status === "stale") return err("staleSession", "Session belongs to a previous target generation");
            if (deps.targetSession.isStale(s.targetGeneration)) return err("targetGenerationMismatch", "Target generation changed");
        }
        return null;
    }

    // CSV encodings for the flat AngelScript protocol.
    const regCsv = (regs?: Registers): { names: string; values: string } => {
        const names: string[] = [];
        const values: string[] = [];
        for (const [k, v] of Object.entries(regs ?? {})) {
            if (!isSupportedRegister(k) || v === undefined) continue;
            names.push(k);
            values.push(v);
        }
        return { names: names.join(","), values: values.join(",") };
    };

    async function call(req: EmulateRequest, timeoutMs?: number): Promise<EmulateResult> {
        setBusy(true);
        try {
            return await emulate(deps.client, req, timeoutMs);
        } catch (e) {
            if (e instanceof AxError && e.code === ErrorCode.UnknownType) deps.capabilities.reportVerbError("emulate", e);
            throw e;
        } finally {
            setBusy(false);
        }
    }

    async function createSession(input: CreateSessionInput): Promise<EmulatorError | EmulatorSession> {
        const g = guard(false);
        if (g) return g;
        // Close any prior handle first.
        const prev = session();
        if (prev && prev.status !== "closed") await closeSession().catch(() => {});

        seq += 1;
        const id = `emu_${Date.now().toString(36)}_${seq}`;
        const gen = deps.targetSession.generation();
        const mode: EmulatorMode = input.mode ?? "process-backed";
        const reg = regCsv(input.initialRegisters);
        setSession({
            id,
            protocolVersion: EMULATOR_PROTOCOL_VERSION,
            targetGeneration: gen,
            mode,
            status: "creating",
            entryAddress: input.entryAddress,
            stopAddress: input.stopAddress,
            createdAt: nowIso(),
            instructionCount: 0,
            traceDropped: 0,
            registers: {},
        });
        try {
            const res = await call({
                op: "create",
                session: id,
                generation: gen,
                mode: mode === "process-backed" ? "process" : "standalone",
                entry: input.entryAddress,
                stop: input.stopAddress ?? "0x0",
                stack_base: input.stackBase ?? "0x0",
                stack_size: input.stackSize ?? 0x10000,
                reg_names: reg.names,
                reg_values: reg.values,
                breakpoints: (input.breakpoints ?? []).join(","),
                trace: input.trace === false ? 0 : 1,
            });
            if (!res.success) {
                const e = err("emulatorCreationFailed", "Agent reported creation failure");
                setSession((s) => (s ? { ...s, status: "faulted", lastError: e } : s));
                return e;
            }
            const s: EmulatorSession = {
                id,
                protocolVersion: EMULATOR_PROTOCOL_VERSION,
                targetGeneration: gen,
                mode,
                status: "ready",
                entryAddress: input.entryAddress,
                currentRip: res.rip,
                stopAddress: input.stopAddress,
                createdAt: nowIso(),
                instructionCount: 0,
                traceDropped: 0,
                registers: res.registers ?? {},
            };
            setSession(s);
            trace.clear();
            emit(emuEvent(TimelineEventType.EmulatorSessionCreated, "info", `Emulator session created @ ${input.entryAddress} (${mode})`, { sessionId: id, mode, entry: input.entryAddress, generation: gen }));
            return s;
        } catch (e) {
            const kind = e instanceof AxError && e.code === ErrorCode.UnknownType ? "capabilityUnavailable" : "emulatorCreationFailed";
            const emuErr = err(kind, e instanceof Error ? e.message : String(e));
            setSession((s) => (s ? { ...s, status: "faulted", lastError: emuErr } : s));
            return emuErr;
        }
    }

    async function execute(single: boolean, input: RunInput = {}): Promise<EmulatorError | EmulatorRunSummary> {
        const g = guard(true);
        if (g) return g;
        const s = session()!;
        const gen = s.targetGeneration;
        const before = s.registers;
        setSession((cur) => (cur ? { ...cur, status: "running" } : cur));
        emit(emuEvent(TimelineEventType.EmulatorRunStarted, "debug", `${single ? "Step" : "Run"} from ${s.currentRip ?? s.entryAddress}`, { sessionId: s.id, single }));

        try {
            const res = await call(
                {
                    op: single ? "step" : "run",
                    session: s.id,
                    generation: gen,
                    insn_budget: single ? 1 : clampInsnBudget(input.instructionBudget ?? 0),
                    timeout_us: input.timeoutUs ?? 1000000,
                    trace_limit: clampTraceLimit(input.traceLimit ?? 0),
                    ...(input.stopAddress ? { stop: input.stopAddress } : {}),
                },
                RUN_TIMEOUT_MS,
            );

            // Stale check after the await: a target switch mid-run discards the result.
            if (deps.targetSession.isStale(gen)) {
                markStale(s);
                return err("targetGenerationMismatch", "Target generation changed during run");
            }

            const stopReason = (res.stop_reason ?? "unknown") as EmulatorStopReason;
            const after = res.registers ?? {};
            const deltas = computeRegisterDeltas(before, after);
            runSeq += 1;
            const summary: EmulatorRunSummary = {
                runId: runSeq,
                sessionId: s.id,
                targetGeneration: gen,
                entryRip: s.currentRip ?? s.entryAddress,
                finalRip: res.rip ?? s.currentRip ?? s.entryAddress,
                instructionCount: res.instruction_count ?? 0,
                stopReason,
                unicornError: res.unicorn_error,
                faultAddress: res.fault_address,
                durationUs: res.duration_us,
                traceCount: res.trace_count ?? 0,
                traceDropped: res.trace_dropped ?? 0,
                registerDeltas: deltas,
                at: nowIso(),
            };

            // Batch the run's trace into the trace store (one reactive update for the whole run).
            const entries: EmulatedTraceEntry[] = (res.trace ?? []).map((t) => ({ index: t.index, runId: runSeq, address: t.address, size: t.size, bytes: t.bytes }));
            trace.ingestRun(entries, summary);

            const faulted = res.status === "faulted";
            setSession((cur) =>
                cur
                    ? {
                          ...cur,
                          status: (res.status as EmulatorSession["status"]) ?? "completed",
                          currentRip: res.rip,
                          previousRegisters: before,
                          registers: after,
                          instructionCount: res.instruction_total ?? cur.instructionCount,
                          traceDropped: cur.traceDropped + (res.trace_dropped ?? 0),
                          lastError: faulted ? err("unicornError", `fault ${res.fault_address}`, res.unicorn_error) : cur.lastError,
                      }
                    : cur,
            );

            // Timeline: one summary event (+ specific markers). Never one event per instruction.
            const events: TimelineEventInput[] = [];
            const runType = faulted ? TimelineEventType.EmulatorRunFaulted : stopReason === "breakpoint" || stopReason === "instruction_limit" || stopReason === "timeout" ? TimelineEventType.EmulatorRunStopped : TimelineEventType.EmulatorRunCompleted;
            events.push(
                emuEvent(runType, faulted ? "warning" : "info", `${single ? "Step" : "Run"} ${stopReason} — ${summary.instructionCount} insns, rip ${summary.finalRip}`, {
                    sessionId: s.id,
                    runId: runSeq,
                    entryRip: summary.entryRip,
                    finalRip: summary.finalRip,
                    instructionCount: summary.instructionCount,
                    stopReason,
                    durationUs: summary.durationUs,
                    traceCount: summary.traceCount,
                    traceDropped: summary.traceDropped,
                    generation: gen,
                    unicornError: res.unicorn_error,
                    faultAddress: res.fault_address,
                }),
            );
            if (stopReason === "breakpoint" && res.breakpoint && res.breakpoint !== "0x0") {
                events.push(emuEvent(TimelineEventType.EmulatorBreakpointHit, "notice", `Emulation breakpoint hit @ ${res.breakpoint}`, { sessionId: s.id, address: res.breakpoint }));
            }
            if ((res.trace_dropped ?? 0) > 0) {
                events.push(emuEvent(TimelineEventType.EmulatorTraceTruncated, "notice", `Trace truncated: ${res.trace_dropped} dropped`, { sessionId: s.id, dropped: res.trace_dropped }));
            }
            deps.timeline.ingestMany(events);
            return summary;
        } catch (e) {
            const emuErr = err("internal", e instanceof Error ? e.message : String(e));
            setSession((cur) => (cur ? { ...cur, status: "faulted", lastError: emuErr } : cur));
            return emuErr;
        }
    }

    function markStale(s: EmulatorSession): void {
        setSession((cur) => (cur ? { ...cur, status: "stale" } : cur));
        emit(emuEvent(TimelineEventType.EmulatorSessionStale, "notice", "Emulator session is stale (target generation changed)", { sessionId: s.id }));
    }

    async function writeRegister(name: string, value: string): Promise<EmulatorError | null> {
        const g = guard(true);
        if (g) return g;
        const s = session()!;
        if (s.status === "running") return err("busy", "cannot edit registers while running");
        if (!isSupportedRegister(name)) return err("invalidRegister", `unknown register: ${name}`);
        try {
            const res = await call({ op: "write_register", session: s.id, generation: s.targetGeneration, reg: name, value });
            if (res.registers) setSession((cur) => (cur ? { ...cur, previousRegisters: cur.registers, registers: res.registers ?? cur.registers, currentRip: res.rip ?? cur.currentRip } : cur));
            emit(emuEvent(TimelineEventType.EmulatorRegisterChanged, "debug", `Emulated register ${name} = ${value}`, { sessionId: s.id, register: name, value }));
            return null;
        } catch (e) {
            return err("registerWriteFailed", e instanceof Error ? e.message : String(e));
        }
    }

    async function readMemory(address: string, size: number): Promise<{ address: string; data: string } | EmulatorError> {
        const g = guard(true);
        if (g) return g;
        const s = session()!;
        try {
            const res = await call({ op: "read_memory", session: s.id, generation: s.targetGeneration, address, size });
            if (!res.success) return err("memoryReadFailed", "emulator memory read failed");
            return { address: res.address ?? address, data: res.data ?? "" };
        } catch (e) {
            return err("memoryReadFailed", e instanceof Error ? e.message : String(e));
        }
    }

    async function reset(): Promise<EmulatorError | null> {
        const g = guard(true);
        if (g) return g;
        const s = session()!;
        try {
            const res = await call({ op: "reset", session: s.id, generation: s.targetGeneration });
            trace.clear();
            setSession((cur) => (cur ? { ...cur, status: "ready", currentRip: res.rip, registers: res.registers ?? cur.registers, instructionCount: 0, traceDropped: 0 } : cur));
            emit(emuEvent(TimelineEventType.EmulatorSessionReset, "info", "Emulator session reset (handle recreated — process-backed pages may reflect newer target memory)", { sessionId: s.id }));
            return null;
        } catch (e) {
            return err("internal", e instanceof Error ? e.message : String(e));
        }
    }

    async function closeSession(): Promise<void> {
        const s = session();
        if (!s) return;
        try {
            await call({ op: "close", session: s.id });
        } catch {
            /* best-effort; the agent also closes on unload/disconnect */
        }
        setSession((cur) => (cur ? { ...cur, status: "closed" } : cur));
        emit(emuEvent(TimelineEventType.EmulatorSessionClosed, "debug", "Emulator session closed", { sessionId: s.id }));
    }

    // Target generation change invalidates the active session synchronously (value compare, not
    // effect-order dependent). We mark it stale; the agent rejects any op for the old generation too.
    createEffect(
        on(
            deps.targetSession.generation,
            () => {
                const s = session();
                if (s && s.status !== "closed" && s.status !== "stale") markStale(s);
            },
            { defer: true },
        ),
    );

    return {
        session,
        trace,
        busy,
        lastError,
        availability,
        capStatus,
        traceCapAvailable,
        createSession,
        run: (i?: RunInput) => execute(false, i),
        step: () => execute(true),
        writeRegister,
        readMemory,
        reset,
        closeSession,
    };
}

export type EmulatorStore = ReturnType<typeof createEmulatorStore>;
