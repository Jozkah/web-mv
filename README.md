# web-mv 🔍

A web-based memory viewer and dynamic analysis tool designed for game reverse engineering, class struct layout reconstruction, string enumeration, and AI-assisted analysis.

Powered by a lightweight Bun relay server and a SolidJS frontend, `web-mv` connects directly to target processes running the **Angel/Echo** agent runtime.

---

## Features

### 🧠 Dynamic Memory Viewer (ReClass-Style)
* **Interactive Class Reconstruction**: Define struct layouts, retype memory fields (integers, floats, doubles, pointers, strings), and inspect live byte snapshots.
* **Auto-Type Guesser**: ReClass-style classification that automatically guesses pointers, floats, vectors, and string fields from live memory bytes.
* **C++ Header Exporter**: Generate ready-to-compile C++ struct definitions complete with offset-calculated padding (`uint8_t pad_0x4[0x8]`) and size assertions.

### 🧵 IDA-Style Strings View
* **Full-Module String Extraction**: Reads a module's virtual memory in chunks and extracts printable ASCII and UTF-16LE strings.
* **Smart Category Filters**: Quick-filter by **URLs**, **File Paths**, **Console Commands**, or **RTTI / Class Names**.
* **Regex Filtering & Exports**: Search with Regular Expressions and export string tables to **CSV**, **JSON**, or **TXT**.
* **Jump to Memory**: Click any string address to immediately open and target a Memory Class at that location.

### ⚡ Static View & Signature Scanner
* **Function Disassembler**: Enumerate and disassemble process functions with syntax highlighting and opcode inspection.
* **Function Sigsearch**: Map signature scan hits directly to containing functions, displaying function names, RVAs, hit offsets (`+0x18`), and prologue (`+0x0`) badges.
* **IDA Signature Scanner**: Search for byte patterns with wildcards, filter by function prologues or mapped code, and resolve RIP-relative instructions (`mov rax, [rip+disp]`).
* **Direct Function Jump**: Jump straight from signature scan results into function disassembly with a single click (`view function`).
* **Disp32 Wildcard Helper**: Automatically wildcard displacement bytes into `??` for IDA pattern creation.

### 🤖 Multi-Agent RPC Multiplexing (`POST /rpc`)
* **AI Agent Integration**: Exposes a stateless HTTP `POST /rpc` endpoint allowing external AI coding agents (such as VSCode extensions or LLM agents) to query memory concurrently without interrupting the browser UI session.

---

## Quick Start

### 1. Build & Launch Server
Make sure [Bun](https://bun.sh) is installed on your machine.

```bash
# Build frontend static bundle and compile relay into release/
build-release.bat

# Launch the relay server (defaults to http://127.0.0.1:8080)
run.bat
```

Open **`http://127.0.0.1:8080`** in your browser.

---

### 2. Connect Target Process (Angel Agent)

Load `web_mv_agent.as` in **Echo/Angel** after launching your target game process:

```angelscript
// web_mv_agent.as
const string PROCESS_NAME = "HuntGame.exe";
const string GAME_MODULE  = "GameHunt.dll";
const string RELAY_URL    = "ws://localhost:8080/agent";

void main() {
    process::attach(PROCESS_NAME, true);
    process::open_socket(RELAY_URL);
}
```

Once connected, the status badge in the top bar will update to **`agent: up`**.

---

## AI Agent / RPC API

External tools and AI agents can query the attached process via HTTP `POST /rpc`.

### Example Request (Read Memory)
```bash
curl -X POST http://127.0.0.1:8080/rpc \
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
