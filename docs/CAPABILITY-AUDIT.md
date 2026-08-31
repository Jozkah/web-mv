# Capability Audit (Phase 0)

This is the machine-honest inventory of what the web-mv workspace can and cannot do, and **why**.
Every gated feature in the UI renders from the negotiated capability set — never from an assumption
that a backend "probably" supports something.

- **Source of truth (code):** [`frontend/src/protocol/capabilities.ts`](../frontend/src/protocol/capabilities.ts)
- **Negotiation store:** [`frontend/src/state/capabilitiesStore.ts`](../frontend/src/state/capabilitiesStore.ts)
- **Handshake verb:** `capabilities` — served by the ext agent (`web_mv_ext_agent.as`), routed to
  `/agent-ext` by the relay. The ext agent is the source of truth for which write-family verbs it
  implements; it reports `{ protocol_version, verbs[] }`.
- **UI:** the status bar "Caps N/M" readout lists every capability, available first, with the exact
  missing Angel primitive shown on hover for anything unavailable.

## Support levels

| Level | Meaning |
|-------|---------|
| `angel-native` | Directly supported by a documented Angel socket route / host call. |
| `angel-derived` | Safely built on documented Angel primitives (e.g. polling reads). |
| `extension-agent` | Implemented by the companion AngelScript agent (`web_mv_ext_agent.as`). |
| `optional-sidecar` | Needs a local sidecar (Ghidra / tshark / capture) that may be absent. |
| `unavailable` | The required primitive **does not exist** in Angel at all. |

`level` describes *how* a capability would be provided. Availability is negotiated separately: an
emulator backed by `uc::` is `angel-native` yet reports `available: false` until the agent advertises
the verb that drives it. The UI reads the negotiated `available`, not the level.

## Matrix

| Capability | Level | Backing (verb / route) | Available when… | Missing primitive if not |
|------------|-------|------------------------|-----------------|--------------------------|
| `memory.read` | angel-native | core `read` / `read_batch` | core agent connected | — |
| `memory.write` | extension-agent | ext `write` | ext agent advertises `write` | ext agent verb: write |
| `memory.regions` | extension-agent | ext `regions` (`virtual_query`) | ext advertises `regions` | ext agent verb: regions¹ |
| `memory.watchPolling` | angel-derived | derived on `memory.read` | memory.read available | — |
| `module.enumerate` | angel-native | core `modules` | core connected | — |
| `module.exports` | extension-agent | ext `exports`/`imports` | ext advertises `exports` | ext agent verb: exports/imports |
| `signature.scan` | angel-native | core `sig_scan`/`sig_scan_ida`/`string_scan` | core connected | — |
| `disassembly.zydis` | angel-native | core `disassemble` (Zydis) | core connected | — |
| `emulation.unicorn` | angel-native | ext `emulate` (`uc::`) | ext advertises `emulate` | ext agent verb: emulate² |
| `scan.value` | extension-agent | ext `scan_new`/`scan_filter` | ext advertises `scan_new` | ext agent verb: scan_new |
| `scan.pointer` | angel-derived | derived on `memory.read` | core connected | —³ |
| `debug.live` | **unavailable** | none | never | live process debug attach |
| `debug.breakpointsSoftware` | **unavailable** | none | never | int3 + debug-event exception delivery |
| `debug.breakpointsHardware` | **unavailable** | none | never | DR0–DR7 via live thread context |
| `debug.registers` | **unavailable** | none | never | GetThreadContext-equivalent |
| `debug.threads` | **unavailable** | none | never | thread enumeration |
| `trace.emulated` | angel-native | ext `emulate` (`uc::hook_code`) | ext advertises `emulate` | ext agent verb: emulate² |
| `trace.live` | **unavailable** | none | never | single-step / branch trace |
| `hook.native` | **unavailable** | none | never | exec alloc + protect + relocate |
| `decompiler.ghidra` | optional-sidecar | sidecar `ghidra` | Ghidra headless configured + probed | configured Ghidra install⁴ |
| `network.pcapImport` | optional-sidecar | sidecar `tshark` | tshark configured | configured tshark install |
| `network.liveCapture` | optional-sidecar | sidecar `capture` | capture backend installed | capture driver / backend |
| `network.processCorrelation` | angel-derived | none (heuristic) | capture backend proves PID/socket | PID/socket ownership mapping |
| `patch.rawBytes` | extension-agent | ext `write` | ext advertises `write` | ext agent verb: write |
| `patch.assemble` | **unavailable** | none | never | an assembler (Zydis disassembles only) |
| `patch.allocate` | **unavailable** | none | never | VirtualAllocEx / VirtualProtectEx |
| `project.persist` | angel-derived | builtin (browser storage) | always | — |

¹ This host's `memory_region` exposes only `base`/`size`/`protect`; `MEM_*` `state`/`type` are
reported as `0`. See the note in `web_mv_ext_agent.as` `handle_regions`.

² **Phase 3: wired.** The ext agent (protocol v2) implements the `emulate` verb over Angel's
Unicorn API (`uc::create`/`uc::create_process`, `uc::setup_stack`, `uc::hook_code`, `uc::reg_*`,
`uc::mem_*`, `uc::start`). Both capabilities now negotiate to **available/confirmed** whenever a v2
agent advertises `emulate`; against an older agent they stay unavailable. This is an **emulator**,
never a live debugger — labels always say so. Execution is safely bounded (see the Unicorn matrix in
[EMULATOR.md](EMULATOR.md)): `uc::start(h, begin, end, timeout_us, count_insns)` enforces an
instruction count and a microsecond timeout, and the code hook returns `false` to stop — so Run and
Step can never run away.

³ **Phase 5: implemented.** Pointer-chain discovery is derived frontend-side from Angel reads
(`scan/pointerChain.ts` reverse search + `scan/pointerScan.ts` bounded map builder). It is scoped to
one module region with a byte budget — whole-process pointer maps are impractical over the browser
transport, so this is honestly a bounded snapshot heuristic, never a live "find-writer". Available
whenever the core agent is connected.

## What Angel confirmed it provides (docs + working repo code)

`process::attach/detach/is_alive`, typed reads + `read_bytes`/`read_buffer`, typed writes +
`write_bytes`, `virtual_query`/`memory_region`, module list + base/size/export, `find_signature(s)`
(masked + IDA), `get_relative_address`, `dump`; socket routes `ping/read/read_batch/modules/
sig_scan/sig_scan_ida/string_scan/resolve_relative/rtti_resolve(_batch)/enumerate_functions/
disassemble`; `zydis::` disassembly; `uc::` (Unicorn) process-backed emulation with code/memory
hooks and register/memory access; sandboxed `file::`/`dir::`; `json::`; `ws::`; threading.

## What Angel confirmed it does **not** provide

Live debugger attach, software/hardware breakpoints, live thread enumeration, live CPU registers,
single-step / execution tracing on the target, native function hooking, target memory
allocation/protection changes, an assembler, raw packet capture, PCAP dissection, and
target-process↔network correlation. These are `unavailable` (or `optional-sidecar` where an external
tool can legitimately fill the gap) and are gated accordingly — no faked working controls.

⁴ **Phase 15: adapter built.** A real local Ghidra headless adapter exists (`relay/src/ghidra.ts`
runner + `/ghidra/*` routes + `relay/ghidra/export_decompiled.py` post-script + frontend
`decompilerStore`/`ghidraParse`/Decompiler view). It runs the **user's** Ghidra on an Angel dump and
maps results back to live addresses — static analysis only, never touching the target. The capability
flips available once a configured `analyzeHeadless` path passes the relay probe. **Not yet
live-validated** (no Ghidra install / driveable Angel host here) — see [GHIDRA.md](GHIDRA.md).

## Handshake provenance (confirmed vs assumed vs derived)

Availability alone is not the whole truth, so each `CapabilityStatus` also carries a `provenance`,
rendered distinctly in the status bar (assumed is **never** shown as equivalent to confirmed):

| Provenance | Meaning |
|------------|---------|
| `confirmed` | Backend reported it — core connected, or an ext verb present in the agent's own `capabilities` reply. |
| `assumed` | Ext connected but the verb list was assumed from `KNOWN_EXT_VERBS` (older agent, or the handshake query failed transiently). Working but unverified. |
| `derived` | Available because another capability is (e.g. `memory.watchPolling` ← `memory.read`). |
| `unavailable` | No primitive, a missing/**downgraded** verb, or an absent sidecar — with a stated reason. |
| `disconnected` | The backing agent/sidecar simply is not connected yet. |

**Downgrade:** if an *assumed* verb is exercised and the agent answers `UnknownType` (code 1000), that
verb is downgraded to `unavailable` for the current connection only. Downgrades are never persisted;
they clear on ext reconnect and on a target-generation change, and reconnection always renegotiates.
Transient failures (timeout, cancellation, disconnect, any non-`UnknownType` error) never downgrade.

## Honesty rules enforced here

- Memory-change polling is **`memory.watchPolling`**, never "find what writes this address". A real
  writer-finder needs `debug.breakpointsHardware` / `trace.live`, both `unavailable`.
- Unicorn is labelled **Emulator**, never Debugger.
- Every `unavailable` capability carries a machine-readable `missingPrimitive` and a user-facing
  `reason`; where a supported path exists it names an `alternative`.
