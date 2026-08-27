# Optional Ghidra headless decompiler (Phase 15)

A real, local, **optional** adapter that runs the user's own Ghidra `analyzeHeadless` on an
Angel-obtained dump and shows the decompiled functions mapped back to live addresses. **Angel remains
the process/memory foundation** — it supplies target identity, attachment, module metadata, live base
addresses, and the dump. Ghidra performs *static* analysis of that dump; it never attaches to, reads,
or writes the live process.

Nothing is downloaded or bundled. The user supplies a local Ghidra install and its path.

## Truth rules (enforced)

- Ghidra output is **static analysis** with provenance `Ghidra` and confidence `derived`. It may be
  incomplete, incorrect, stale, or **mismapped** — the UI flags functions whose address could not be
  mapped to the live space.
- No Ghidra result writes target memory, alters execution, modifies Angel scripts, or auto-applies a
  patch. The decompiler store only ever *reads* (dump + analyze) and caches.
- The capability is **unavailable** until a configured, probe-verified local Ghidra is present.

## Dump transport (audited)

`process::dump(module, name)` writes a PE image to the Angel sandbox `<scripts>/dmp/<name>` on local
disk and returns the filename. The relay (a local process) reads that file **directly** from the
configured dump directory — **no dump bytes cross the WebSocket**. The dump filename is path-traversal
guarded (bare filename only, resolved under `dumpDirectory`).

## Architecture

- **Frontend config** (`state/ghidraConfig.ts`): `analyzeHeadlessPath`, `dumpDirectory`,
  `projectDirectory`, `defaultTimeoutMs`, `maxDumpBytes`, `maxOutputBytes` — persisted, validated.
- **Frontend store** (`state/decompilerStore.ts`): probes on config change (flips the `ghidra`
  sidecar → `decompiler.ghidra` capability), then per module: Angel `dump` → relay `/ghidra/analyze`
  → parse + map + cache. Generation-guarded (a target change discards in-flight work and clears the
  cache). Emits `decompiler.job.started/completed/failed` timeline events (source `decompiler`,
  provenance `Ghidra`).
- **Parser + mapping** (`decompiler/ghidraParse.ts`, pure/tested): validates the export JSON and maps
  Ghidra addresses `live = liveBase + (ghidraAddr − imageBase)`, flagging any address below the image
  base as unmapped.
- **Relay runner** (`relay/src/ghidra.ts`): `probe()` (checks `analyzeHeadless` exists) and
  `analyze()` — spawns `analyzeHeadless` with an **argv array (never a shell string)**, bounds
  timeout + dump size + output size, and returns the post-script's raw JSON. Routes:
  `POST /ghidra/probe`, `POST /ghidra/analyze` (loopback only).
- **Ghidra post-scripts** (Jython, in the user's Ghidra): `export_analysis.py` (metadata only — no
  decompiler) and `decompile_function.py` (one function by entry address).

## Metadata analysis vs. on-demand decompilation (Phase 15.1)

The two operations are strictly separated so a module analysis can never spawn thousands of
long decompiles:

- **`Analyze module`** → `POST /ghidra/analyze` → `export_analysis.py`. Auto-analyzes the dump and
  exports **only bounded metadata**: image base, arch/compiler, memory blocks, function
  entries/names/ranges/signatures/calling-conventions, symbols, warnings, truncation. **No
  decompiler is imported or called.** The relay keeps a bounded, persistent Ghidra project and
  returns an opaque `analysisId`.
- **`Decompile selected function`** → `POST /ghidra/decompile` → `decompile_function.py`. Runs
  **only on an explicit click**, for exactly one function. The request carries only validated
  identifiers (`analysisId` + a hex `functionEntry`) — **never** a dump/project/script path or a
  function name. The relay reopens the cached project (`-process`, `-noanalysis`) and decompiles that
  one function. Duplicate in-flight requests are deduplicated; results are cached.

Pseudocode is produced **only** on explicit request — never during module analysis, never when the
function list renders, never merely on row selection.

**Performance tradeoff (honest):** the metadata analysis keeps a persistent Ghidra project (bounded
to 16, oldest evicted + its `.gpr`/`.rep` deleted) so a decompile reopens the already-analyzed
program rather than re-importing. If a Ghidra version does not support `-process` project reuse as
expected, re-importing per decompile is the fallback — slower, same result.

## Caches

- **Metadata cache** (per module fingerprint = name:size): the mapped function list. Cleared with
  "clear metadata".
- **Pseudocode cache** (per `analysisId:functionEntry`): one function's decompiled text. Cleared per
  function. A **target-generation change makes live mapping stale but does NOT destroy the static
  caches** (they belong to the dump image). Import remains inert; nothing re-analyzes automatically.

## Sidecar states (honest wording)

A path check proves only that the executable exists — never that Ghidra can analyze a dump:

`unconfigured` → `pathValid` → `readyUnvalidated` (path exists, runner can start, **no real analysis
has succeeded**) → `liveValidated` (a real dump analysis succeeded) · `failed` / `timedOut` (bounded
diagnostics). `decompiler.ghidra` may be available for config/UI once the path probes, but the view
shows **readyUnvalidated** until an analysis actually succeeds. A path check is never called a
successful Ghidra probe.

## Configuration

In the Decompiler tab: set the `analyzeHeadless` path and the Angel dump directory, tick Enabled. The
relay probe then flips `decompiler.ghidra` to available. Select a module and Decompile.

## Lifecycle hardening (Phase 15.3)

The relay runner now has a `bun test` suite (`relay/src/ghidra.test.ts`) that injects a fake process
through a spawn seam (`__setSpawn`) — no Ghidra needed — and proves: function-entry validation and
injection rejection, dump-filename traversal rejection, unknown-analysis behavior, same-function
deduplication (one spawn), different-function **serialization per analysis** (one Ghidra process per
project at a time), independent cross-analysis concurrency, LRU eviction by a **monotonic** `lastUsed`
(not coarse/back-steppable `Date.now()`), eviction **skipping any analysis with a queued/running
decompile**, exact `.gpr`/`.rep` deletion (nothing else), no poisoned locks after spawn-failure or
timeout, and structured timeouts. Two latent issues were fixed: the per-analysis serialization chain is
now dropped on eviction (was unbounded growth), and a decompile's `finally` reclaims over-cap analyses
so capacity returns to the bound after jobs finish.

These are STATIC-behaviour tests of the relay orchestration, not evidence of real Ghidra behavior.

## Live validation status — BLOCKED (not proven here)

**Ghidra is not installed in this environment, and no live Angel host is driveable here**, so the
end-to-end path (dump → Ghidra → mapped functions) was **NOT executed**. The adapter, parser, relay
runner, routes, post-script, UI, and tests are complete and the pure logic is unit-tested with
fixtures, but `decompiler.ghidra` remains **not live-validated**. Do not claim successful
decompilation until an interactive run with a real local Ghidra passes.

### To validate on an interactive machine

1. Install Ghidra locally; note the `analyzeHeadless(.bat)` path.
2. Launch the relay + frontend; connect the core + ext Angel agents; attach a harmless module target.
3. In the Decompiler tab, set the path + the Angel `<scripts>\dmp` directory, enable, and confirm the
   status pill flips to **available**.
4. Decompile a small module; verify function addresses map to live addresses and pseudocode appears.
5. Confirm target memory is unchanged (the emulator/patch byte-compare procedure applies) — the
   decompiler never writes the target by construction (it only calls `dump` + the relay).

## Limits

analyzeHeadless timeout (default 120 s, ceiling 10 min); dump ≤ `maxDumpBytes` (default 64 MiB);
export ≤ `maxOutputBytes` (default 16 MiB); metadata ≤ 20 000 functions / 20 000 symbols per export;
one decompile per request with pseudocode ≤ 200 000 chars; persistent projects ≤ 16 (oldest evicted);
stderr tail bounded to 2 KB. **No eager whole-module decompilation.**
