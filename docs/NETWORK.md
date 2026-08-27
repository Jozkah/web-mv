# Network Workbench — offline PCAP analysis (optional tshark sidecar)

A real, local, **optional** adapter that runs the user's own `tshark` (the Wireshark CLI) on a capture
file the user already has, and renders a Wireshark-style three-pane workbench (packet list · protocol
tree · raw bytes). Nothing is downloaded or bundled — the user supplies a local tshark install and its
path.

## What this is NOT (honesty invariants — enforced)

- **Not live capture.** Every tshark invocation reads a file (`-r`); the live-capture flag (`-i`) is
  never constructed. `network.liveCapture` is a separate, more privileged capability that stays
  **unavailable** unless an authorized capture backend is installed and validated.
- **Not tied to the attached target.** A pcap carries no process identity — there is no PID/socket
  ownership in a capture file — so packets are **never** attributed to the attached Angel process.
  `network.processCorrelation` is **unavailable by construction**. The timeline never infers causality
  between a packet and a memory event from timestamp proximity.
- **Angel is unrelated to packet capture.** Angel has no capture primitive; tshark supplies the
  dissection of a file the user provides. This adapter does not touch the target at all.

## Capabilities

| Capability | State | Why |
|------------|-------|-----|
| `network.pcapImport` | available **only after** the configured tshark passes a bounded `--version` preflight (`runnable`) | offline dissection of a user-supplied capture |
| `network.liveCapture` | **unavailable** | needs an authorized capture backend + driver, explicitly validated |
| `network.processCorrelation` | **unavailable** | Angel/pcap provide no PID↔socket ownership; heuristic timeline proximity is never causality |

Path existence is **not** runnable validation. Sidecar states: `unconfigured → pathValid → runnable
(preflight passed) → readyUnvalidated → liveValidated (a real capture was dissected)`, plus `failed`
/ `timedOut`.

## Security & bounds (relay `relay/src/tshark.ts`)

- **argv arrays only** — never a shell string. The frontend never supplies flags: it sends typed
  fields (a bare pcap filename, an integer frame/stream, or a display-filter expression) that the relay
  translates into an **allowlisted** argv. The `-e` field list is fixed in code; the frontend cannot
  add fields.
- **`-n`** is always passed → tshark performs no name resolution (no DNS / network egress).
- **Path traversal + symlink guard** (`resolvePcapPath`): bare filename only, resolved and
  `realpath`-checked to stay inside the configured `pcapDirectory`.
- **Content validation** (`validatePcapMagic`): the file is validated by **magic bytes** (classic pcap
  either endianness incl. nanosecond, or pcapng), never by extension. **gzip-compressed captures are
  rejected** (decompression-bomb vector).
- **Display filter** (`isValidDisplayFilter`): passed as one `-Y` token (can never be parsed as another
  option or a shell command); still bounded to 512 chars and rejected if it contains control chars or a
  leading dash.
- **Bounds:** capture size (`maxCaptureBytes`), packet count (`-c maxPackets`), stdout bytes
  (`maxOutputBytes`, with kill-on-overflow), a per-job timeout (kills the child), and a concurrent-job
  cap. Raw bytes are requested **only** for an explicitly selected packet (`-x` on a single
  `frame.number==N`), never for the whole capture.

## Operations (routes: `POST /tshark/probe`, `POST /tshark/analyze`)

- **Import** → `op: "summary"` → `-T fields` allowlisted columns → the packet list.
- **Display filter** → `op: "filter"` → same columns with a validated `-Y`.
- **Dissect one packet** → `op: "dissect"` → `-T json -x` for one `frame.number==N` → protocol tree +
  raw bytes. Runs only on row selection, cached per `pcap#frame`.
- **Follow stream** → `op: "follow"` → `-z follow,{tcp|udp},raw,<index>` → directional decoded chunks,
  byte-bounded.

## Parsing (frontend boundary `src/network/pcapParse.ts`, pure + tested)

All tshark output is validated/normalized at the frontend boundary. Tab summaries are parsed by header
with the free-text `Info` column **last** (it can itself contain tabs). The `-T json` dissection is
validated with a zod shape and built into a bounded protocol tree (node + depth caps). Conversations
and endpoints are **derived client-side** from the packet fields (not scraped from tshark's decorative
`-z conv` tables). Versioned via `PCAP_SCHEMA_VERSION`.

## Timeline

Summary events only (never one per packet), source `network`, provenance
`tshark offline PCAP analysis`: `network.pcap.importStarted/Completed/Failed/Cancelled`,
`network.pcap.filterApplied`, `network.pcap.streamFollowed`, `network.pcap.truncated`,
`network.pcap.cacheHit`.

## Project-bundle integration (inert, Phase 16)

The Network Workbench contributes **inert metadata** to the versioned project bundle (schema v2). What
is persisted: capture content hash (stable identity), original filename (basename only — no path
authority), file size, format, packet count, first/last timestamp, protocol summary, endpoints,
conversations, packet **bookmarks** and **annotations** (each keyed by `(captureHash, frameNumber)`,
never a row index), capture-level annotations, saved display filters, follow-stream **references**
(type + index, never payloads), truncation metadata, tshark provenance/version, whether the source PCAP
was available at save, and an optional internal cache reference.

**Never persisted:** raw PCAP bytes, unbounded packet arrays, raw packet payloads, full followed
streams, absolute external paths, active tshark jobs, PIDs, relay child-process state, arbitrary command
arguments, live-capture configuration, or credentials. Every array is capped (`NET_LIMITS`) and packet
references dedupe deterministically by frame.

### Import is inert; relink is explicit and hash-verified

Importing a project shows the network metadata + annotations **immediately** with the source PCAP marked
**unavailable**. Import never launches tshark, reads a file, applies a filter, follows a stream, attaches
a target, or performs any Angel/network operation, and it can **not** override the local tshark config or
mark the sidecar live-validated.

To analyze again the user clicks **Relink** and picks a local capture. Relink runs the *existing*
explicit summary flow (containment, size, and magic all enforced relay-side), then compares the file's
sha256 to the saved hash. A **mismatch is refused** unless the user explicitly forces it; on adopt,
annotations are re-keyed to the live hash so they are preserved by frame identity. Schema migration
carries v1 bundles (no network) forward; a bundle newer than the app understands fails cleanly rather
than importing partial state.

## Follow-stream parser limitations (UNPROVEN against real tshark)

`parseFollowStream` is tolerant by design: it never throws on junk, bounds bytes **before** allocating,
preserves direction from indentation (the raw-mode marker), normalizes hex to lowercase, and **reports a
`malformed` count** rather than silently dropping data while claiming success (an empty valid stream is
distinct from a parse failure). The exact `-z follow,{tcp,udp},raw,<n>` layout across tshark versions
remains **UNPROVEN** without a real install; fixtures are synthetic.

## Live validation status — BLOCKED (not proven here)

**tshark is not installed in this environment**, so the end-to-end path (a real capture → tshark → the
three panes) was **NOT executed**. The relay adapter, routes, parser, store, view, and tests are
complete and the pure logic is unit-tested with fixtures (relay `bun test`, frontend `vitest`), but the
capability is **not live-validated**. The following remain **UNPROVEN** without a real tshark:

- exact `-z follow,<proto>,raw,<n>` output layout across tshark versions (the follow parser's
  direction/hex heuristic);
- the precise `-T json -x` object shape (validated defensively by zod — a mismatch surfaces as a
  structured error, never a crash);
- `_ws.col.Info` never containing the tab separator in a way the last-column rule can't absorb;
- real child-kill semantics on timeout / output-overflow on the host OS.

### To validate on a machine with tshark

1. Install Wireshark/tshark; note the `tshark(.exe)` path.
2. In the Network tab, set the path + a directory holding a small `.pcapng`, enable — the status pill
   flips to **runnable**.
3. Import the capture → the packet list populates and the state flips to **validated**.
4. Select a packet → the protocol tree + raw bytes appear. Apply a display filter. Follow a TCP stream.
5. Confirm the capture file is unmodified and the attached target is untouched (this adapter only reads
   the pcap; it never writes the target).
