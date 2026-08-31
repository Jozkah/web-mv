# Unicorn Emulator (Phase 3)

Offline x86-64 emulation built on Angel's documented `uc::` (Unicorn) API. **This is an emulator,
never a debugger.** `uc::create_process()` demand-loads pages from the attached process, but all
execution and state live inside Unicorn and the target process is never modified. The UI, protocol,
and timeline all say "emulated"; a Run/Step trace is emulated instructions, not instructions the live
target executed.

## Angel Unicorn capability audit (verified against the official docs)

| Item | Angel API | Verified signature | Status |
|------|-----------|--------------------|--------|
| Standalone emulator | `uc::create()` | `uint64 uc::create()` (0 = fail) | supported |
| Process-backed emulator | `uc::create_process()` | `uint64 uc::create_process()` (0 = no target) | supported |
| Page demand-load | (implicit in `create_process`) | region-granular, on fault, Win32 prot | supported |
| Explicit mapping | `uc::mem_map` | `bool mem_map(h, addr, size, uint perms)` | supported |
| Protection change | `uc::mem_protect` | `bool mem_protect(h, addr, size, perms)` | supported (emulator only) |
| Memory read | `uc::mem_read` | `bool mem_read(h, addr, uint32 size, array<uint8>&out)` | supported |
| Memory write | `uc::mem_write` | `bool mem_write(h, addr, const array<uint8>&in)` | supported (emulator only) |
| Register read/write | `uc::reg_read64` / `reg_write64` | `bool (h, x86_reg, uint64&out/uint64)` | supported (GP + rip/rsp/rbp/eflags/r8–r15) |
| Code hook | `uc::hook_code` | `bool hook_code(h, code_hook_fn@, begin=1, end=0)`; cb `bool(h,addr,uint32 size)` | supported |
| Unmapped-memory hook | `uc::hook_memory_unmapped` | `bool (h, mem_hook_fn@, begin, end)` | supported (not used this phase) |
| Instruction bytes | `uc::mem_read` inside the hook | `mem_read(h, address, size, out)` | supported |
| Stack setup | `uc::setup_stack` | `bool setup_stack(h, base, size, stop_address)` (writes stop addr; `ret` halts) | supported |
| Start | `uc::start` | `int start(h, begin, end, timeout=0, count=0)` → `uc::error` | supported |
| **Instruction-count limit** | `uc::start` `count` param | `count` in instructions (0 = unlimited) | **supported** |
| **Timeout limit** | `uc::start` `timeout` param | `timeout` in microseconds | **supported** |
| Programmatic stop | `uc::stop` / hook returns `false` | `void stop(h)`; cb `false` halts | supported |
| Safe single-step | `uc::start` `count=1` | one instruction, deterministic | supported |
| Error reporting | `uc::last_error` / `uc::fault_address` | `uint32` / `uint64`; `uc::error::*` enum | supported |
| Handle cleanup | `uc::close` | `void close(h)`; auto-cleanup on unload | supported |
| Mapped-region query | `uc::mem_query` / `uc::mem_regions` | supported (not surfaced this phase) | supported |
| Multiple concurrent handles | — | not documented as safe → **default single session** | conservative |
| Thread safety | — | not documented → **serialize all handle ops** | conservative |
| SIMD/segment/control regs | `x86_reg::xmm*/ymm*/cs/…`, `reg_read128/256` | exposed but **not surfaced this phase** | deferred |

**Feasibility gate: PASS.** A safe hard execution bound exists three ways over — instruction count,
microsecond timeout, and a hook that returns `false`. Run and Step are therefore safe and enabled.

## Process-backed vs. standalone

- **Process-backed** (`uc::create_process()`): requires an attached target; pages are demand-loaded
  from the process at region granularity with Win32 protection. It is **not** a frozen snapshot — a
  fault reads whatever the target holds at that moment. The target is never written.
- **Standalone** (`uc::create()`): needs explicit `mem_map` regions + written bytes. Wired in the
  agent but the UI defaults to process-backed; standalone create is available via protocol.

## Session lifecycle & target-generation

One session at a time; creating a new one closes the previous handle. Every session binds to the
target generation captured at creation. A target detach/change marks the session **stale**
synchronously (value compare, effect-order independent); the agent also rejects any op whose
`generation` ≠ the session's. A run whose generation changes mid-flight is discarded (never applied).
`on_unload()`, disconnect, and reset all close the Unicorn handle — no leaks.

Statuses: `idle → creating → ready → running → (paused | completed | faulted) → closed`, plus
`stale`.

## Supported registers

`rax rbx rcx rdx rsi rdi rbp rsp rip eflags r8–r15` — read/written via `uc::reg_read64/reg_write64`.
All values are canonical hex strings across JSON (64-bit safe). SIMD/segment/control/FPU registers
are intentionally not surfaced this phase (available in Angel via `reg_read128/256`).

## Run / Step / Reset

- **Run:** `uc::start(h, rip, stop, timeout_us, insn_budget)`. Defaults: 100k instructions, 1 s;
  hard caps 5M instructions, 5 s. Returns final registers, executed-instruction count, a bounded
  trace, stop reason, `uc::error` code, fault address, and duration.
- **Step:** `uc::start` with `count = 1` — one deterministic instruction.
- **Reset:** closes and **recreates** the handle from the stored create config. For process-backed
  sessions this means demand-loaded pages may reflect **newer** target memory — it is honestly *not*
  a snapshot restore.

Stop reasons are distinct (never a generic "failed"): `stop_reached`, `instruction_limit`,
`timeout`, `breakpoint`, `invalid_instruction`, `unmapped_read/write/fetch`,
`protection_read/write/fetch`, `unicorn_error`, `stale`, `trace_limit`.

## Trace behavior & limits

The code hook records `{index, address, size, bytes}` per emulated instruction (bytes via
`uc::mem_read` inside the hook). Bounds: default 10,000 entries/run, hard max 200,000; over the limit
the agent stops recording and reports a dropped count (the frontend store also caps at 200,000).
Per-instruction **register deltas are not** produced (the hook exposes only address/size; snapshotting
all registers per instruction would be prohibitive) — register deltas are computed at the **run**
level (before vs. after). Inline disassembly of trace bytes is deferred (no bytes-disassembly relay
verb yet); rows show address + bytes, and disassembly of unmodified process-backed code is available
through the existing Disassembly view.

Trace transport is **batched per run** — never one WebSocket message or one reactive update per
instruction. The trace list is virtualized.

## Emulation breakpoints

Address breakpoints are honored **inside the emulator only** — the code hook returns `false` at a
breakpoint address (the entry instruction is skipped so a paused session can resume). No `int3` is
written and target memory is never modified. Labelled "Emulation breakpoint". Memory watchpoints are
not implemented this phase.

## Emulator memory vs. target memory

`read_memory`/`write_memory` operate on **Unicorn** memory only (`uc::mem_read`/`mem_write`), capped
at 64 KiB per request; a write invalidates Unicorn's code cache (`uc::flush_code`). Emulator writes
are never presented as target writes and there is **no** "apply emulator changes to process" action.
The target Memory Viewer remains a separate, explicitly-labelled evidence source.

## Timeline integration

`source: "emulator"` events via `timeline.ingestMany()`: session created/reset/closed/stale, run
started/completed/stopped/faulted, breakpoint hit, trace truncated, register/memory changed. A
run-completed event carries session id, entry/final RIP, instruction count, stop reason, duration,
trace count, truncated count, and target generation. **No per-instruction timeline events** —
instruction-level data stays in the bounded trace store. `confidence: exact`, `provenance: "Angel
Unicorn emulation"`. Never infers live-process behavior or causality.

## Import / export

Versioned JSON (`format: "web-mv.emulator-trace"`, `schemaVersion: 1`): session metadata, registers,
entry/stop, run summaries, trace entries, truncation, provenance. Imported traces are **read-only** —
they cannot call the agent or touch the target — and are marked imported; a newer/unknown schema is
rejected cleanly.

## Safety limits (agent-enforced)

One active session; stack ≤ 1 MiB; instructions ≤ 5M/run; timeout ≤ 5 s; trace ≤ 200k; memory
read/write ≤ 64 KiB; breakpoints ≤ 256. All return explicit limit errors — no unbounded allocation in
the agent or frontend.

## Unsupported (with exact Angel blocker)

Live debugging, target pause/resume/step, target breakpoints (int3/DR0–DR7), live thread/register
access, writer/accessor identification, applying emulator state to the target, and OS/syscall/API
simulation are **not** provided — Angel exposes no live-execution-control or thread-context
primitive; these are outside `uc::` entirely. Standalone-mode UI, SIMD registers, inline trace
disassembly, and function-call ABI setup are deferred (the primitives exist; the surface is not built
this phase).

## Live smoke-test procedure (AngelScript has no compiler in this repo — run manually)

1. Load `web_mv_ext_agent.as` in Angel.
2. Confirm `emulate` appears in the `capabilities` reply (frontend "Caps" shows emulation.unicorn confirmed).
3. Attach a test process.
4. Create a bounded session at a known harmless code address.
5. Verify initial registers.
6. Run within a strict instruction budget; verify the trace.
7. Verify target memory is unchanged (compare via the target Memory Viewer).
8. Reset; confirm state is rebuilt.
9. Change the target; confirm the session becomes stale.
10. Close the session.
11. Unload the script; confirm no leaked handle or crash.

**This live smoke test was NOT run in this environment** (no Angel host / attached process available
here). The AngelScript adapter was written against the verified `uc::` API and reviewed manually only.

**Phase 14 update:** Level‑1 static consistency was verified (agent↔protocol op/register/field/version
agreement; no target-write route in emulator paths — see `EMULATOR-SMOKE-TEST.md`), and a closed-session
guard defect was fixed. The live ladder (Levels 2–10) remains **BLOCKED** — no driveable Angel host —
so `emulation.unicorn` / `trace.emulated` are still **not live-validated**.
