# web-mv reverse-engineering platform

A cohesive memory-analysis workspace built around the capabilities **Angel actually provides**
(`process::*`, `zydis::`, `uc::` Unicorn, sandboxed `file::`, `ws::`). Every feature renders from a
typed, negotiated capability set — nothing fakes a backend it does not have.

Architecture (unchanged from the original design): a **core Angel agent** (`process::open_socket` on
`/agent`) + a **companion AngelScript ext agent** (`ws::connect` on `/agent-ext`,
`web_mv_ext_agent.as`) → a **relay** (`/rpc`, `/ui`, agent sockets) → a **SolidJS frontend**.

## Phase map

| Phase | Feature | Angel basis | Docs |
|-------|---------|-------------|------|
| 0 | Typed capability negotiation | handshake over agents | [CAPABILITY-AUDIT.md](CAPABILITY-AUDIT.md) |
| 1 | Unified event timeline | frontend, fed by all producers | — |
| 2 | Memory Watch (change polling) | `read`/`read_batch` (angel-derived) | [MEMORY-WATCH.md](MEMORY-WATCH.md) |
| 3 | Unicorn Emulator | `uc::` via ext `emulate` verb | [EMULATOR.md](EMULATOR.md) |
| 4 | (Emulator = phase 3) | — | — |
| 5 | Scanner + pointer-chain discovery | ext scan verbs + `read` (derived) | this file |
| 6 | Static analysis + navigation | `disassemble`/`enumerate_functions` (pre-existing) + palette actions | — |
| 7 | Safe patch workspace | ext `write` verb | this file |
| 8 | Project database (export/import/compare) | frontend persistence | this file |
| 9 | Decompiler (Ghidra) | optional sidecar — **unavailable until configured** | this file |
| 10 | Network workbench (PCAP/tshark) | optional sidecar — **implemented + fixture-tested; live BLOCKED without tshark** | [NETWORK.md](NETWORK.md) |
| 11 | Debugger / Hook Lab contracts | **unavailable** (no Angel primitive) | this file |
| 12 | Resizable panes + accessibility | frontend | this file |
| 13 | Perf / integration / docs | — | this file |

## Honesty invariants (enforced across the platform)

- **Memory Watch** polls; it detects *that* a value changed, never *which instruction* wrote it. A
  disabled "Find writer" states the exact missing Angel primitive.
- **Unicorn** is an **emulator**, never a debugger. Execution is bounded (instruction count +
  timeout + hook-stop). Emulated state is never presented as target state.
- **Pointer-chain discovery** is a bounded, scoped snapshot heuristic — never a find-writer.
- **Patches** always retain original bytes and are reversible; saved/imported patches never
  auto-apply; a target change marks applied patches stale.
- **Decompiler / Debugger / Hook Lab** render honest *unavailable* states from the capability
  registry (exact missing primitive or missing sidecar), never fake working controls. Typed provider
  contracts (`src/providers/contracts.ts`) are the seams a future adapter plugs into.
- **Network (PCAP)** is real OFFLINE analysis via an optional tshark sidecar — it NEVER captures live
  packets and NEVER attributes packets to the attached target (a capture carries no PID/socket
  ownership). `network.liveCapture` and `network.processCorrelation` stay **unavailable** by
  construction. See [NETWORK.md](NETWORK.md).

## Target-generation safety

A single atomic transition authority (`state/targetSession.ts`) assigns a generation before any
target-dependent async work; every long operation captures the generation and discards a result if
the target changed mid-flight (Memory Watch samples, emulator runs, and patch writes all honor this).
Per-target workspace state is namespaced by a fingerprint, and per-connection capability downgrades
clear on reconnect / generation change.

## Provider contracts (future adapters)

`src/providers/contracts.ts` defines `DecompilerProvider` (Ghidra headless over Angel dumps),
`NetworkPcapProvider` (tshark), `DebuggerProvider` (an explicit, authorized live-debug dependency —
NOT Angel), and `HookProvider` (a safely-verified hooking backend). Wiring any of these is additive:
the capability negotiation flips the relevant capability, and the existing gated UI reveals the real
content in place of the unavailable panel.

## CSV exports (RFC-4180 + spreadsheet-safe)

All CSV file exports go through one pure serializer, `src/ui/csv.ts` — never `JSON.stringify` (which
produced backslash-escaped, non-RFC-4180 output). The caller labels each cell from schema knowledge:

- `text()` — user-controlled/target-derived text (watch display, target strings, notes). Gets RFC-4180
  quoting **and** a spreadsheet-formula guard: a value whose first non-whitespace char is `=`, `+`, `-`,
  `@`, tab, or CR is prefixed with a `'` so a sheet shows it literally.
- `num()` — numeric/boolean/canonical values. RFC-4180 only, **no** formula guard, so a real negative
  number stays a negative number. BigInt is preserved exactly; `NaN`/`Infinity`/`-Infinity` use those
  literal forms.
- `raw()` — already-safe canonical tokens (hex addresses, ISO timestamps): quoted only if needed.

Rows end with CRLF; output is deterministic. Consumers: Memory Watch history and the Strings export.

## Performance benchmarks

`npx vitest run src/__benchmarks__/perf.test.ts --disable-console-intercept` prints median/p90 for the
major workloads (warm-up + samples). They assert **structure** (counts, bounded retention, exactly one
reactive recompute per timeline batch) — not wall-clock — so CI noise never fails the build. Reference
medians on the dev machine (synthetic fixtures, not a benchmarking rig): timeline ingestMany(10k) ~8 ms
with a single recompute; timeline filter/group(10k) ~1 ms/~0.2 ms; pcap parse(5k) ~4 ms + derive
endpoints/conversations ~1 ms/~0.4 ms; ghidra mapAnalysis(5k) ~1.2 ms; csv serialize(5k) ~1.2 ms. No
path exceeded ~8 ms, so no optimization was warranted — limits and virtualization were left intact.

## Build & test

- Frontend: `npm run typecheck` (`tsc -b`), `npx vitest run`, `npm run build` (`tsc -b && vite build`).
- Relay: `tsc -p tsconfig.json --noEmit`, `bun test`, `bun build src/index.ts`.
- AngelScript (`web_mv_ext_agent.as`): no compiler in-repo — manual review + the live smoke-test
  checklists in the per-feature docs.
