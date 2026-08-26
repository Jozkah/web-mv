# web-mv 🔍

A web-based memory viewer and dynamic analysis tool designed for game reverse engineering, class struct layout reconstruction, string enumeration, and AI-assisted analysis.

Powered by a lightweight Bun relay server and a SolidJS frontend, `web-mv` connects directly to target processes running the **Angel/Echo** agent runtime.

---

## Features

### 🧠 Dynamic Memory Viewer (ReClass-Style)
* **Interactive Class Reconstruction**: Define struct layouts, retype memory fields, and inspect live byte snapshots.
* **Rich Field Types**: integers and bitfields (with **named bits**), floats/doubles, `vec2`/`vec3`/`vec4`, a 4x4 **matrix**, data + **function pointers**, ASCII/UTF-16 strings with a **user-configurable length**, `union` views (one slot decoded as int/float/hex at once), and **references to named structs/enums** from the Data Types registry — nested struct fields render inline as collapsible rows. Per-field **display format** (auto/dec/hex/bin) and **endianness** (little/big, where safe) via the right-click menu.
* **Live Inspection Controls**: pause/resume polling (pausing freezes the snapshot and stops region *and* pointer-preview reads), **Refresh once** while paused, a 100/250/500/1000 ms interval selector, and a Live/Paused/Reading/Error status badge. The interval and pause preference persist; snapshot bytes never do.
* **Baseline Compare**: capture the current region as a baseline, then every field that differs from it is marked (separately from the per-tick change highlight). A **Changed only** toggle shows just those fields; changing the class, base address, or layout size invalidates the baseline automatically.
* **Inline Typed Editing**: double-click a value (or press Enter) to edit it in place — decimal/hex/binary integers with width+sign bounds checking, floats, bools, pointers, strings (capacity-checked, NUL-padded), bitfields, vectors, matrices, and enum members **by name**. Writes are validated before sending, show pending/error states, and the region is re-read after a successful write — the grid never fakes bytes locally. Process writes are not part of layout undo.
* **Search, Filters & Go-To**: search across field name, offset, absolute address, displayed value, and type; filter All / Changed / Pointers / Unnamed / Numeric; "goto 0x…" jumps the virtualized list to an offset. Filtered rows keep their original indices, so rename/retype/delete/insert/repeat always hit the right node.
* **Controlled Auto-Analysis**: separate **Auto guess** / **Auto grow** toggles (persisted per target) plus a one-shot **Analyze** button. Every guess carries a confidence tier and a reason; automatic mode applies only **high-confidence** results (follow-check-verified pointers, NUL-terminated strings) while medium/low guesses appear as reviewable per-row suggestions with accept one / accept selected / accept all / reject. Fields can be **locked** (🔒) against all automatic changes; auto-grow stops at 0x1000 bytes and while paused or detached. Stale suggestions are re-verified against the current snapshot before applying.
* **Pointer-Preview Budgeting**: preview modes **Expanded only** (default) / **Visible** / **All**, a configurable max previews per cycle, expanded > selected > visible prioritization, per-target read deduplication, and a "N throttled" indicator when the budget is exceeded. RTTI stays cached per attachment and clears on target switch.
* **Keyboard-First Grid**: ↑/↓ move, Shift+↑/↓ and Shift+click extend ranges, Home/End/PageUp/PageDown navigate, Ctrl/Cmd+A selects all filtered rows, Enter edits the value, F2 renames, Delete removes (undo-able), Menu key / Shift+F10 opens the field menu, Escape closes editors/menus/suggestions. Shortcuts never fire while typing in an input or modal.
* **C++ Header Exporter**: Generate ready-to-compile C++ struct definitions complete with offset-calculated padding (`uint8_t pad_0x4[0x8]`), vectors/matrices as float arrays, unions, enum/struct references, and size assertions.

### 🧵 IDA-Style Strings View
* **Full-Module String Extraction**: Reads a module's virtual memory in chunks and extracts printable ASCII and UTF-16LE strings.
* **Smart Category Filters**: Quick-filter by **URLs**, **File Paths**, **Console Commands**, or **RTTI / Class Names**.
* **Regex Filtering & Exports**: Search with Regular Expressions and export string tables to **CSV**, **JSON**, or **TXT**.
* **Jump to Memory**: Click any string address to immediately open and target a Memory Class at that location.

### ⚡ Static View & Signature Tools
* **Function Disassembler**: Enumerate and disassemble process functions with syntax highlighting and opcode inspection.
* **IDA-Style SigMaker**: Generate minimal unique pattern scan signatures for **any address** — disassembled **code** or **raw data bytes** — not just functions, with automatic RIP-relative (`disp32`) and call/jump (`rel32`) wildcarding. Launch it from the top bar (type any address), the disassembly/function panels, or the memory view's `⚡ sig` button; a **Code / Raw bytes** toggle disassembles on the fly or reads bytes verbatim.
* **Auto-Find Unique Signature**: Iteratively expands instruction depth to find the shortest 100% unique signature (1 hit in module) in live process memory.
* **Interactive Byte Editor**: Visual byte breakdown with clickable pills to toggle wildcard masks per byte manually.
* **Multi-Format Exporters**: One-click copy for **IDA Pattern** (`48 8B 05 ?? ??`), **C++ String & Mask**, **C++ Byte Array**, **C++ 0x?? Array**, and **Python**.
* **Function Sigsearch**: Map signature scan hits directly to containing functions, displaying function names, RVAs, hit offsets (`+0x18`), and prologue (`+0x0`) badges.
* **IDA Signature Scanner**: Search for byte patterns with wildcards, filter by function prologues or mapped code, and resolve RIP-relative instructions (`mov rax, [rip+disp]`).
* **Direct Function Jump**: Jump straight from signature scan results into function disassembly with a single click (`view function`).

### 🤖 Multi-Agent RPC Multiplexing (`POST /rpc`)
* **AI Agent Integration**: Exposes a stateless HTTP `POST /rpc` endpoint allowing external AI coding agents (such as VSCode extensions or LLM agents) to query memory concurrently without interrupting the browser UI session.

### 📌 Cheat Table & Memory Writing (`/agent-ext`)
* **Cheat Table View**: A persisted watch list of addresses. Each row shows a live-decoded value (`u8`–`u64`, `i8`–`i64`, `f32`, `f64`), lets you push an edited value back to the process, and can be **frozen** — re-written to a captured value every poll tick (Cheat Engine style).
* **Memory Writing**: New `write` verb (`process::write_bytes`) for patching values and bytes.
* **Module Dumping**: `dump` verb wrapping `process::dump` for on-disk image dumps.
* **Import / Export Tables**: `exports` and `imports` verbs walk a module's PE export/import directories (IMAGE_DIRECTORY_ENTRY_EXPORT/IMPORT) and return named symbols with addresses / IAT slots.
* **PE / Symbols View** (`🧩` tab): pick any module and dump it, or walk its **section headers** (`sections` verb — name, RVA, virtual/raw size, r/w/x protection), **exports**, and **imports** in on-demand tables.
* **Address Labels**: a shared resolver renders any absolute address as `module+0xRVA`.
* **Bookmarks View** (`🔖` tab): a persisted list of pinned addresses with labels/notes; each jumps straight to the memory viewer or the disassembler.
* **Snapshot Diff View** (`🔬` tab): capture a memory region as a baseline, then re-read and list exactly which bytes changed — a region-scoped stand-in for a value scanner.
* **Memory Inspector** (`🧩` tab): a live hex + ASCII dump of any region with click-to-edit bytes (read on a poll, single-byte write).

### 🔗 Workflow glue
* **Ext-agent status badge**: the top bar shows `ext: up/down` so the write-family features aren't a silent no-op when `web_mv_ext_agent.as` isn't loaded.
* **Send-to actions**: push an address into the Cheat Table or Bookmarks straight from the strings, PE exports/imports/sections, and snapshot-diff views (shared stores back both).
* **Write safety**: writes surface failures, **undo last write** restores the prior bytes, and an **echo-verify** re-reads to warn when the game immediately overwrites your value.
* **JSON export/import**: cheat tables and bookmarks are portable via one-click download / file import.
* **Address labels**: any absolute address resolves to `module+0xRVA`.

These write-family verbs are served by a **separate extension agent** (`web_mv_ext_agent.as`) over a second relay endpoint (`/agent-ext`); the relay routes each request by verb, so the browser talks to one server. See setup step 2 below.

> **Architecture note.** Echo's built-in memory server (`process::open_socket`) serves the read/scan/disassemble verbs and cannot be extended from this repo, and only one such socket can bind the relay's `/agent` endpoint at a time. The mutation verbs therefore live in a companion AngelScript agent that attaches to the same process and speaks a custom `ws::connect` handler on `/agent-ext`. Run both scripts together.

---

## Quick Start

### 1. Build & Launch Server
Make sure [Bun](https://bun.sh) is installed on your machine.

```bash
# Build frontend static bundle and compile relay into release/
build-release.bat

# Launch the relay server (defaults to http://127.0.0.1:9000)
run.bat
```

Open **`http://127.0.0.1:9000`** in your browser.

---

### 2. Connect Target Process (Angel Agent)

Load `example_agent_script.as` in **Echo/Angel** after launching your target game process:

```angelscript
// example_agent_script.as
const string PROCESS_NAME = "HuntGame.exe";
const string GAME_MODULE  = "GameHunt.dll";
const string RELAY_URL    = "ws://localhost:9000/agent";

void main() {
    process::attach(PROCESS_NAME, true);
    process::open_socket(RELAY_URL);
}
```

Once connected, the status badge in the top bar will update to **`agent: up`**.

**For the Cheat Table / write features**, also load `web_mv_ext_agent.as` in Echo/Angel (set its `PROCESS_NAME` to match). It attaches to the same process and connects to the relay's `/agent-ext` endpoint, adding the `write` / `dump` / `exports` / `imports` verbs. The read/scan tools work with only the core script; loading the ext script is what enables writing and freezing.

---

## AI Agent / RPC API

External tools and AI agents can query the attached process via HTTP `POST /rpc`.

### Example Request (Read Memory)
```bash
curl -X POST http://127.0.0.1:9000/rpc \
  -H "Content-Type: application/json" \
  -H "x-mv-client: vscode-agent" \
  -d '{
    "type": "read",
    "address": "0x7ff6abcd1234",
    "size": 64
  }'
```

### Supported RPC Commands
* `ping` — Check agent attachment status and process base address
* `read` / `read_batch` — Read raw memory bytes
* `modules` — Enumerate loaded modules (`name`, `base`, `size`)
* `sig_scan` / `sig_scan_ida` — Perform IDA pattern scans
* `rtti_resolve` / `rtti_resolve_batch` — Resolve RTTI class names
* `enumerate_functions` — List module functions
* `disassemble` — Disassemble code at target address

---

## License

MIT

