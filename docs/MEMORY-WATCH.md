# Memory Watch (Phase 2)

Memory Watch polls memory addresses through documented Angel reads and reports how their values
change over time. It is built on the negotiated capability `memory.watchPolling` (derived from
`memory.read`).

## Memory Watch vs. a debugger watchpoint — read this first

**Polling can detect that memory changed. It cannot determine which instruction accessed or wrote
it.** Memory Watch is therefore never labelled "find what writes/accesses this address", "hardware
watchpoint", "data breakpoint", "writer/accessor", or "trace". A disabled **Find writer** action in
the UI states exactly why:

> Angel does not expose live thread context, hardware debug registers, breakpoint events, or
> execution tracing. Memory Watch can detect value changes but cannot identify the writing
> instruction.

A real writer-finder needs `debug.breakpointsHardware` or `trace.live`, both `unavailable` in the
capability audit. If a future debugger adapter negotiates one of those, a Find-writer feature can be
added **without changing Memory Watch semantics** — Memory Watch stays a polling change-detector.

## Polling limitations

- Sample cadence is bounded by the polling transport, not the CPU. A value that changes and reverts
  between two polls is invisible. Change counts and history are per-poll, never per-write.
- `changeCount` counts polls where the raw bytes differed from the previous **successful** poll.
- Paused time (detached / hidden / user pause) produces no samples and is never counted as
  "unchanged".

## Scheduler architecture

One central scheduler (`watch/scheduler.ts`), **one timer per distinct effective interval** — never
one `setInterval` per watch. Each bucket tick, if the scheduler is active, captures the target
generation, gathers that bucket's due watches, and runs a single cycle. A cycle already in flight
for a bucket is skipped (coalesced) so reads never overlap for the same bucket.

- **Read planning** (`watch/readplan.ts`): identical address+size reads are de-duplicated (a safe
  form of coalescing) and packed into bounded `read_batch` requests (≤64 entries, ≤256 KiB/batch,
  ≤64 KiB/entry). Adjacency merging across distinct ranges is intentionally **not** done — it would
  risk reading across unknown/unreadable region boundaries; it is future work gated on region
  validation.
- **Batching** uses the existing core `read_batch` route (verified schema in
  `protocol/schemas.ts`) — no new protocol shapes were invented.
- **Pause conditions**: core disconnected, target detached, document hidden, global pause, or a
  per-watch disable. Resuming never treats elapsed hidden time as samples.
- **Manual "read now"** bypasses the timer but still captures the generation and obeys byte limits.
- **Backoff**: consecutive failures apply bounded exponential backoff (base = max(interval, 500ms),
  ×2 per failure, capped); a successful read resets it. Backoff state is visible in the inspector.

## Supported value types

`int8/16/32/64`, `uint8/16/32/64`, `float32/64`, `bool`, `pointer`, `bytes`, `ascii`, `utf8`,
`utf16le`, `utf16be`. 64-bit integers and pointers use **BigInt** (never a lossy JS number). Raw
bytes are preserved alongside every decoded value. NaN/Infinity, partial reads, and invalid string
encodings are represented explicitly. **Deferred**: registered data-type/structure decoding and
bit-field types (the model reserves them; structure-field diffing needs the existing layout engine).

Display bases: `auto`, `hex`, `decimal`, `binary`, `char`. A display-base change never counts as a
memory-value change (comparison is on raw bytes / decoded value, not formatting).

## Address-expression behavior

Resolution reuses the project's BigInt address arithmetic (`state/address.ts`) — 64-bit precision
throughout. Supported: absolute hex/decimal expressions (`0x14000abcd`, `140000000 + 0x28`) and
module-relative expressions (`client.dll+0x1234`, `ntdll.dll`). The entered expression and the
resolved address are shown separately. Module-relative expressions re-resolve each cycle against the
current target's module list; absolute-address watches are flagged with **relocation risk** (they
move on re-attach / ASLR). An invalid expression fails only its own watch. **Pointer-chain
expressions are not resolved here** (no pointer scanning this phase).

## Comparison semantics (`watch/compare.ts`, pure)

Basis: previous successful read, initial/manual baseline, or an entered constant. Modes: changed,
unchanged, increased, decreased, increasedBy, decreasedBy, equal, notEqual, greater, less,
greaterEqual, lessEqual, range, crossedUp, crossedDown, bitChanged, bitSet, bitCleared,
pointerChanged, bytePatternChanged, stringChanged, stringContains, structureBytesChanged.
Signedness comes from the decoded value's kind; floats compare as numbers with optional epsilon;
**NaN never compares as a normal number**. The first successful read establishes `previous`; failed
reads never replace `previous` or `baseline`.

## Trigger behavior (`watch/triggers.ts`, pure)

A trigger turns a predicate match into a firing decision: transition-only (default) or every sample,
with a consecutive-match threshold, cooldown, and one-shot mode. Actions in this phase: add timeline
event, visually flag the watch, pause the watch, pause all. **No arbitrary code, writes, shell
commands, webhooks, or network actions.** Trigger state (count, last-fire, flag) is separate from the
watch definition and resettable.

## Timeline event policy

Events use the Phase-1 `timeline.ingestMany()` so one polling cycle causes **one** timeline
recomputation, never one per watch. Emitted types: `memory.watch.created/updated/removed/enabled/
disabled/changed/triggered/error/recovered/baselineCaptured/paused/resumed`. Noise control:

- No event for unchanged samples.
- `changed` events are rate-limited per watch (≥1 s apart); suppressed changes are counted and
  reported as `coalescedChanges` + a start time on the next emitted event. Per-watch emission can be
  turned off.
- `error` is emitted only on transition into error (or a changed error kind); `recovered` once after
  the next successful read.
- Every event carries `confidence: exact`, `provenance: "Angel polling read"`, and the target
  generation. It never infers writer, thread, instruction, or causal network activity.

## Retention and byte budgets

Per-watch bounded history (default 256 samples, 16–4096), plus a global 8 MiB byte budget across all
watches that evicts the globally-oldest samples. Dropped-sample counts are exposed. History is
**segmented by target generation** — a target change closes the previous segment instead of merging
values across processes. Full project-database persistence is out of scope.

## Target-generation safety

A single atomic transition authority (`state/targetSession.ts`) assigns the generation before any
target-dependent async work. Each polling cycle captures the generation at start and **discards** its
result if the generation changed mid-flight (the watch goes `stale`, its value is not applied) — a
value comparison, independent of Solid effect order.

## Persistence safety

Definitions persist to `localStorage` (versioned, migrated); runtime (timers, promises, sockets,
current values) is never persisted. A saved watch loads **pending** and does not poll until
explicitly **armed** against the current target — old watches never auto-poll a newly attached,
unrelated process. Imported watches load pending too and never trigger writes or external actions.
Module-relative expressions are preferred for portability; absolute-address watches show relocation
risk.

## Performance limits (measured, mocked transport)

- 500-watch changed cycle: **42.4 ms**, 500 change events, **1** timeline recomputation (not 500)
  — via `ingestMany`. (`src/state/__tests__/watchStore.test.ts` perf test.)
- Timeline stays bounded at 5000 events; `ingestMany` of 250 events triggers exactly one reactive
  version bump.
- Watch table and timeline are virtualized — 1000 definitions render without unbounded DOM.
- Idle/paused scheduler creates no read traffic; stop clears all timers.

## Capability states

`available` (memory.read live) · `assumed` (legacy capability fallback, shown honestly) · `paused`
(core disconnected / detached / hidden / user pause) · `unavailable` (memory.read not negotiated) ·
`stale` (result from a previous generation, discarded) · `error`/backoff (per-watch, isolated). A
definitive `UnknownType` on a verb downgrades it through the Phase-1 downgrade path. One failed watch
never stops the scheduler or other watches.
