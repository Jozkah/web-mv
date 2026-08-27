import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { createListVirtualizer } from "../../ui/virtualList";
import { makeModuleLookup, resolveWatchAddress } from "../../watch/resolve";
import { SUPPORTED_REGISTERS, type EmulatorRunSummary } from "../../emulator/model";
import "./emulator.css";

// Unicorn Emulator workspace. Offline / process-backed emulated execution — labelled "emulated"
// everywhere. Run and Step are safe because uc::start() bounds execution by instruction count and a
// microsecond timeout, and the code hook halts at emulation breakpoints. Never a live debugger.

const ROW_H = 26;

const AVAIL: Record<string, { text: string; tone: string; detail: string }> = {
    available: { text: "Emulator ready", tone: "live", detail: "emulation.unicorn confirmed" },
    assumed: { text: "Emulator (assumed capability)", tone: "warn", detail: "capability assumed, not confirmed" },
    unavailable: { text: "Emulator unavailable", tone: "danger", detail: "Extension agent lacks the `emulate` verb (uc:: not wired). Load a build of web_mv_ext_agent.as with the emulate verb." },
    disconnected: { text: "Extension agent disconnected", tone: "idle", detail: "Connect the extension agent (web_mv_ext_agent.as)." },
};

export function EmulatorView() {
    const app = useApp();
    const emu = app.emulator;

    const [entry, setEntry] = createSignal("");
    const [stopAddr, setStopAddr] = createSignal("");
    const [insnBudget, setInsnBudget] = createSignal(100000);
    const [traceLimit, setTraceLimit] = createSignal(10000);
    const [filter, setFilter] = createSignal("");
    const [statusMsg, setStatusMsg] = createSignal<string>();

    const s = () => emu.session();
    const canOperate = () => emu.availability() === "available" || emu.availability() === "assumed";
    const running = () => s()?.status === "running" || emu.busy();

    const resolveEntry = (expr: string): string | undefined => {
        const lookup = makeModuleLookup(app.modules.list().map((m) => ({ name: m.name, base: m.base })));
        const r = resolveWatchAddress(expr, lookup);
        return r.ok ? r.address : undefined;
    };

    const create = async () => {
        setStatusMsg(undefined);
        const addr = resolveEntry(entry().trim());
        if (!addr) { setStatusMsg("Invalid entry address expression"); return; }
        const stop = stopAddr().trim() ? resolveEntry(stopAddr().trim()) : undefined;
        const res = await emu.createSession({ entryAddress: addr, stopAddress: stop, mode: "process-backed" });
        if ("kind" in res) setStatusMsg(`${res.kind}: ${res.message}`);
    };
    const run = async () => {
        const res = await emu.run({ instructionBudget: insnBudget(), traceLimit: traceLimit(), stopAddress: stopAddr().trim() ? resolveEntry(stopAddr().trim()) : undefined });
        if (res && "kind" in res) setStatusMsg(`${res.kind}: ${res.message}`);
    };
    const step = async () => { const res = await emu.step(); if (res && "kind" in res) setStatusMsg(`${res.kind}: ${res.message}`); };

    const lastRun = createMemo<EmulatorRunSummary | undefined>(() => { const r = emu.trace.runs(); return r[r.length - 1]; });

    // trace virtualization
    emu.trace.setFilter({ text: filter() || undefined });
    const rows = createMemo(() => emu.trace.filtered());
    const { setRef, virtualizer } = createListVirtualizer(() => rows().length, ROW_H);

    const doExportTrace = () => {
        const cur = s();
        const blob = new Blob([emu.trace.exportJSON({
            appVersion: "web-mv",
            entryAddress: cur?.entryAddress,
            stopAddress: cur?.stopAddress,
            initialRegisters: undefined,
            finalRegisters: cur?.registers as Record<string, string> | undefined,
            provenance: "Angel Unicorn emulation",
        })], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `emulator-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; a.click();
        URL.revokeObjectURL(url);
    };

    const avail = () => AVAIL[emu.availability()];

    return (
        <div class="emu-view">
            <div class="emu-controlbar">
                <input class="emu-input" placeholder="Entry address, e.g. game.exe+0x1000 or 0x14000abcd" value={entry()} onInput={(e) => setEntry(e.currentTarget.value)} />
                <input class="emu-input emu-input-sm" placeholder="Stop addr (opt)" value={stopAddr()} onInput={(e) => setStopAddr(e.currentTarget.value)} />
                <button class="emu-btn" disabled={!canOperate() || !app.attached() || running()} onClick={create} title="Create / recreate the emulator session">Create</button>
                <button class="emu-btn" disabled={!s() || running() || s()?.status === "stale"} onClick={run} title="Run (bounded by instruction budget + timeout)">Run ▶</button>
                <button class="emu-btn" disabled={!s() || running() || s()?.status === "stale"} onClick={step} title="Step one emulated instruction (uc::start count=1)">Step ⤼</button>
                <button class="emu-btn" disabled={!s() || running()} onClick={() => emu.reset()} title="Reset — recreate handle (process-backed pages may reflect newer target memory)">Reset</button>
                <button class="emu-btn" disabled={!s()} onClick={() => emu.closeSession()}>Close</button>

                <span class="emu-field">insn <input type="number" class="emu-num" value={insnBudget()} min="1" onInput={(e) => setInsnBudget(Number(e.currentTarget.value))} /></span>
                <span class="emu-field">trace <input type="number" class="emu-num" value={traceLimit()} min="1" onInput={(e) => setTraceLimit(Number(e.currentTarget.value))} /></span>

                <div class="emu-spacer" />
                <span class={`emu-avail tone-${avail().tone}`} title={avail().detail}>{avail().text}</span>
                <span class="emu-gen" title="Target generation this session is bound to">gen {s()?.targetGeneration ?? app.targetGeneration()}</span>
            </div>

            <Show when={!canOperate()}>
                <div class="emu-banner">{avail().detail}</div>
            </Show>
            <Show when={statusMsg()}><div class="emu-banner warn">{statusMsg()}</div></Show>
            <Show when={s()?.status === "stale"}><div class="emu-banner warn">Session is stale — the target generation changed. Create a new session.</div></Show>
            <Show when={s()?.status === "faulted"}><div class="emu-banner danger">Session faulted: {s()?.lastError?.kind} {s()?.lastError?.message}</div></Show>

            <div class="emu-body">
                <div class="emu-registers">
                    <div class="emu-pane-head">Emulated registers</div>
                    <Show when={s()} fallback={<div class="emu-empty">No session. Enter an entry address and Create.</div>}>
                        <div class="emu-reg-grid">
                            <For each={SUPPORTED_REGISTERS}>
                                {(name) => {
                                    const val = () => s()!.registers[name] ?? "";
                                    const changed = () => { const p = s()!.previousRegisters?.[name]; return p !== undefined && p !== val(); };
                                    return (
                                        <div class="emu-reg-row" classList={{ changed: changed() }}>
                                            <span class="emu-reg-name">{name}</span>
                                            <input
                                                class="emu-reg-val"
                                                value={val()}
                                                disabled={running() || s()!.status === "stale"}
                                                onChange={(e) => emu.writeRegister(name, e.currentTarget.value.trim())}
                                                aria-label={`emulated ${name}`}
                                            />
                                        </div>
                                    );
                                }}
                            </For>
                        </div>
                    </Show>
                </div>

                <div class="emu-trace">
                    <div class="emu-pane-head">
                        Emulated trace ({emu.trace.count()})
                        <Show when={emu.trace.dropped() > 0}><span class="emu-warn"> · {emu.trace.dropped()} dropped</span></Show>
                        <input class="emu-trace-filter" placeholder="filter address/bytes" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
                        <button class="emu-btn sm" onClick={doExportTrace} disabled={emu.trace.count() === 0}>Export</button>
                    </div>
                    <div class="emu-trace-head">
                        <span class="emu-tc-idx">#</span><span class="emu-tc-addr">Address</span><span class="emu-tc-size">Sz</span><span class="emu-tc-bytes">Bytes</span>
                    </div>
                    <div class="emu-trace-body" ref={setRef}>
                        <Show when={rows().length > 0} fallback={<div class="emu-empty">No emulated instructions yet. Create a session and Run.</div>}>
                            <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
                                <For each={virtualizer.getVirtualItems()}>
                                    {(vi) => {
                                        const t = () => rows()[vi.index];
                                        return (
                                            <div class="emu-trace-row" style={{ transform: `translateY(${vi.start}px)`, height: `${ROW_H}px` }}
                                                onClick={() => navigator.clipboard?.writeText(t().address)}
                                                title="Emulated instruction — click to copy its address">
                                                <span class="emu-tc-idx">{t().index}</span>
                                                <span class="emu-tc-addr">{t().address}</span>
                                                <span class="emu-tc-size">{t().size ?? ""}</span>
                                                <span class="emu-tc-bytes">{t().bytes ?? ""}</span>
                                            </div>
                                        );
                                    }}
                                </For>
                            </div>
                        </Show>
                    </div>
                </div>

                <div class="emu-details">
                    <div class="emu-pane-head">Details</div>
                    <Show when={s()} fallback={<div class="emu-empty">—</div>}>
                        <dl class="emu-fields">
                            <dt>Session</dt><dd>{s()!.id}</dd>
                            <dt>Mode</dt><dd>{s()!.mode}</dd>
                            <dt>Status</dt><dd>{s()!.status}</dd>
                            <dt>Entry</dt><dd>{s()!.entryAddress}</dd>
                            <dt>RIP</dt><dd>{s()!.currentRip ?? "—"}</dd>
                            <dt>Instr total</dt><dd>{s()!.instructionCount}</dd>
                        </dl>
                        <Show when={lastRun()}>
                            {(r) => (
                                <>
                                    <div class="emu-pane-sub">Last run</div>
                                    <dl class="emu-fields">
                                        <dt>Stop</dt><dd>{r().stopReason}</dd>
                                        <dt>Instrs</dt><dd>{r().instructionCount}</dd>
                                        <dt>Final RIP</dt><dd>{r().finalRip}</dd>
                                        <dt>Duration</dt><dd>{r().durationUs ?? "—"} µs</dd>
                                        <Show when={r().faultAddress && r().faultAddress !== "0x0"}><dt>Fault</dt><dd>{r().faultAddress}</dd></Show>
                                        <dt>Trace</dt><dd>{r().traceCount} (+{r().traceDropped} dropped)</dd>
                                    </dl>
                                    <Show when={Object.keys(r().registerDeltas).length > 0}>
                                        <div class="emu-pane-sub">Register deltas (run)</div>
                                        <div class="emu-deltas">
                                            <For each={Object.entries(r().registerDeltas)}>
                                                {([name, d]) => <div class="emu-delta"><span>{name}</span><span class="emu-mono">{d.before} → {d.after}</span></div>}
                                            </For>
                                        </div>
                                    </Show>
                                </>
                            )}
                        </Show>
                        <p class="emu-note">Emulated state only. Emulator memory/register writes never touch the target process. Trace rows are emulated instructions, not instructions executed by the live target.</p>
                    </Show>
                </div>
            </div>
        </div>
    );
}
