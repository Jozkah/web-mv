# Emulator live smoke test (Phase 14)

**Status: live validation BLOCKED — no driveable Angel host in this environment.**
Level‑1 static consistency PASSED (read-only, evidence-based). The live ladder (Levels 2–10) could
not be exercised and is reported BLOCKED, not PASS. No smoke test was simulated with mocks.

## Environment audit (read-only)

| Prerequisite | Found | Evidence |
|---|---|---|
| Angel host installed/running | Unknown / not driveable | Discord + NVIDIA overlay processes present, but no way to operate the Angel overlay menu, load a script, or read the Angel console from this non-interactive shell. |
| Overlay prerequisites satisfied | Cannot confirm | Angel injects via the Discord overlay; that UI is not automatable here. |
| Extension script deployed | **No** | `web_mv_ext_agent.as` is **not** in `%APPDATA%\Roaming\scripts` (only unrelated scripts `bodycam.as`, `huntshowdown.as` are present — left untouched). |
| Core agent connected | **No** | The relay is not running; no `/agent` socket. |
| Extension agent connected | **No** | No `/agent-ext` socket. |
| Harmless target fixture | **No** | Repo has no emulator fixture; the only local processes are unrelated (and `huntshowdown` is a multiplayer game — a forbidden target, not attached). |
| Emulator capability confirmed live | **No** | Requires the ext agent's `capabilities` reply over a live socket. |

**Exact blockers:** (1) relay + frontend not launched; (2) ext script not loaded into an Angel host;
(3) the Angel overlay is not automatable from this shell; (4) no harmless test fixture process. All
four must be satisfied on an interactive machine to run Levels 2–10.

Deployment was **not** performed: loading requires the interactive overlay regardless, and the deploy
directory holds unrelated third-party scripts that must not be disturbed. Deploy + load is a user
step (copy `web_mv_ext_agent.as` into the Angel scripts folder, load it via the overlay).

## Level 1 — static consistency (PASS, evidence)

| Check | Result | Evidence |
|---|---|---|
| `emulate` advertised in capabilities reply | PASS | `handle_capabilities` verb list includes `"emulate"`. |
| `emulate` in dispatch | PASS | `on_ws_message`: `else if (type == "emulate") handle_emulate(...)`. |
| Relay permits verb | PASS | `EXT_VERBS` contains `"emulate"` (`relay/src/relay.ts`). |
| Op names agree | PASS | Agent `handle_emulate` dispatch = create/status/read_registers/write_register/read_memory/write_memory/run/step/reset/close = frontend `EmulateRequest["op"]`. |
| Register names agree | PASS | Agent `emu_reg`/`emu_reg_names` = frontend `SUPPORTED_REGISTERS` (rax…r15, rip, rsp, rbp, eflags). |
| Response fields ⊆ schema | PASS | Every agent `emulate_result` field (session/mode/status/stop_reason/rip/registers/instruction_*/trace_*/unicorn_error/fault_address/duration_us/breakpoint/trace/address/data/bytes_written) is present/optional in `schemas.emulateResult`. |
| Protocol versions agree | PASS | `EXT_PROTOCOL_VERSION = 2` (agent) = `CAPABILITY_PROTOCOL_VERSION = 2` (frontend). |
| Address encoding precision-safe | PASS | Agent `hex_addr` emits `0x…` lowercase; schema `hexAddr` regex `^0x[0-9a-f]+$`; frontend keeps addresses/regs as hex strings + BigInt. |
| Handle cleanup paths | PASS | `emu_close_handle` (uc::close); `emu_build` closes-then-creates; `on_unload()` + `on_disconnect_click` close; `handle_emu_close` closes. |
| `on_unload()` closes handle | PASS | `on_unload` → `emu_close_handle()`. |
| Generation carried per op | PASS | Frontend sends `generation` on create/run/step/write_register/read_memory/reset; agent `emu_session_ok` rejects on mismatch. |
| Response IDs correlate | PASS | Agent echoes numeric `id`; `AxClient` matches by id. |
| Trace bounded before serialization | PASS | Hook stops recording at `g_tr_limit` and counts `g_tr_dropped`; `emu_trace_json` iterates the bounded buffer. |
| **No target-write verb in emulator paths** | PASS | `process::write_bytes` appears only in `handle_write` (line 243); emulator handlers use `uc::mem_write`/`uc::reg_write64`/`uc::start` exclusively. |

## Defect fixed this phase (static review)

- **Closed session not rejected frontend-side.** `emulatorStore.guard()` rejected `stale` sessions
  but let operations through on a `closed`/`closing` session (they only failed later at the agent).
  Fixed to reject with `invalidSession`. Regression test added.

## Live ladder result table (all BLOCKED)

| Test | Result | Notes |
|---|---|---|
| Script load | BLOCKED | No driveable Angel host / overlay. |
| Capability confirmed (live) | BLOCKED | No live `capabilities` reply. |
| Session create | BLOCKED | No agent connected. |
| Register round trip | BLOCKED | — |
| Deterministic run (`nop; ret`) | BLOCKED | — |
| Instruction limit (`jmp $`, tiny budget) | BLOCKED | — |
| Trace | BLOCKED | — |
| Reset | BLOCKED | — |
| Process-backed pages | BLOCKED | No harmless fixture; will not attach to unrelated processes. |
| Target unchanged (byte compare) | BLOCKED | — |
| Generation stale | BLOCKED (live) | Covered by mock regression tests only. |
| Disconnect/reconnect | BLOCKED (live) | Covered by mock regression tests only. |
| Unload cleanup | BLOCKED | Requires observing the Angel host on unload. |

## Regression tests added (mock — application behavior, NOT Angel runtime proof)

- Emulator never calls the target `write` route (only ever sends the `emulate` verb).
- Closed session rejects further operations.
- Reset clears the trace and updates registers.
(Plus the existing lifecycle/run/generation-stale/late-response/UnknownType-downgrade/truncation tests.)

## Capability truth after Phase 14

Unchanged and honest: `emulation.unicorn` / `trace.emulated` remain **not live-validated**. They are
`angel-native` and negotiate available/confirmed once a v2 ext agent advertises `emulate`, but this
has **not** been observed executing inside a live Angel host. The "needs live smoke test" caveat in
`EMULATOR.md` stays until an interactive run completes the ladder above.

## To complete this phase (on an interactive machine)

1. Launch the relay (`bun run relay/src/index.ts`) and open the frontend.
2. Load the core Angel agent and `web_mv_ext_agent.as` via the overlay; confirm both sockets connect.
3. Confirm the "Caps" readout shows `emulation.unicorn` **confirmed**.
4. Start a harmless local fixture (a long-running process with a tiny arithmetic/branch function).
5. Run Levels 3–9 from this document; record registers, instruction count, stop reason, trace count,
   duration, and a before/after byte comparison proving target memory is unchanged.
6. Update this table with measured PASS/FAIL and, only if all pass, mark `EMULATOR.md` live-validated
   with the date + tested Angel version.
