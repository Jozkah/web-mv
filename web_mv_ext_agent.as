// web_mv_ext_agent.as — Echo/Angel EXTENSION agent for web-mv (write-family verbs)
//
// This is the companion to example_agent_script.as. Run BOTH at once:
//   * example_agent_script.as  -> Echo's built-in memory server (read/sig_scan/disasm/...)
//                                 via process::open_socket, connected to the relay's /agent.
//   * web_mv_ext_agent.as (this) -> a custom ws:: handler on the relay's /agent-ext, adding
//                                 the mutation + scan verbs the built-in server does not expose.
//
// The relay (relay/src/relay.ts) routes each request frame by verb: write-family -> /agent-ext,
// everything else -> /agent. The browser talks to one relay and never sees the split.
//
// Everything here uses only documented Angel host calls (process::write_bytes / read_uint64 /
// read_uint32 / read_float / read_string / read_buffer / dump, ws::*, and the standard
// AngelScript string addon). Confirmed-SAFE scalar/array types only:
// float, int, uint, uint32, uint16, uint8, uint64, bool, array<uint64>, array<float>,
// memory_buffer@. NO dictionary type; scan state lives in parallel global arrays.
//
// Ported from huntshowdown.as (the live agent's wmx_-prefixed block: write/dump/exports/
// imports/sections/regions/scan_new/scan_filter/scan_clear/pe_header/pe_dirs) using this
// file's own (non-prefixed) helper naming, plus new verbs: resource_tree, raw_scan,
// scan_grouped, iat_rebuild, and an "unknown initial value" scan_new mode.

const string PROCESS_NAME = "HuntGame.exe";                // Target process (match your core script)
const string EXT_RELAY_URL = "ws://127.0.0.1:9000/agent-ext";

// Capability-handshake protocol version. Bump when the verb set or reply shapes change in a way
// the frontend must notice. The frontend compares against CAPABILITY_PROTOCOL_VERSION.
// v2 adds the `emulate` verb family (Unicorn emulator).
const int EXT_PROTOCOL_VERSION = 2;

// --- Emulator (Unicorn) limits -------------------------------------------------
// Conservative bounds so a single emulate op can never hang the ws handler or allocate unbounded.
const uint64 EMU_INSN_BUDGET_DEFAULT = 100000;      // instructions per run if unspecified
const uint64 EMU_INSN_BUDGET_MAX     = 5000000;     // hard cap on instructions per run
const uint64 EMU_TIMEOUT_US_DEFAULT  = 1000000;     // 1s per run if unspecified
const uint64 EMU_TIMEOUT_US_MAX      = 5000000;     // 5s hard cap
const uint   EMU_TRACE_LIMIT_DEFAULT = 10000;
const uint   EMU_TRACE_LIMIT_MAX     = 200000;
const uint64 EMU_STACK_SIZE_DEFAULT  = 0x10000;     // 64 KiB
const uint64 EMU_STACK_SIZE_MAX      = 0x100000;    // 1 MiB
const uint   EMU_MEM_READ_MAX        = 0x10000;     // 64 KiB per emulator memory read
const uint   EMU_MEM_WRITE_MAX       = 0x10000;     // 64 KiB per emulator memory write
const uint   EMU_BREAKPOINT_MAX      = 256;

// Bound the PE-table walks so a corrupt header can never spin us forever.
const uint MAX_EXPORT_NAMES = 50000;
const uint MAX_IMPORT_DESCRIPTORS = 4096;
const uint MAX_IMPORT_THUNKS = 40000;

bool g_attached = false;

void notify(const string &in msg, int r, int g, int b)
{
    print("[web-mv ext] " + msg);
    alert::show_tag(msg, "webmv-ext", r, g, b);
}

bool ensure_attached()
{
    if (g_attached && process::is_alive()) return true;
    attach_data d = process::attach(PROCESS_NAME, true);
    if (d.pid == 0) { g_attached = false; return false; }
    g_attached = true;
    return true;
}

// --- tiny hex / json helpers (standard string addon only) -------------------

int hex_val(uint8 c)
{
    if (c >= 0x30 && c <= 0x39) return int(c) - 0x30;       // 0-9
    if (c >= 0x61 && c <= 0x66) return int(c) - 0x61 + 10;  // a-f
    if (c >= 0x41 && c <= 0x46) return int(c) - 0x41 + 10;  // A-F
    return -1;
}

uint64 parse_u64_hex(const string &in in)
{
    uint start = 0;
    if (in.length() >= 2 && in[0] == 0x30 && (in[1] == 0x78 || in[1] == 0x58)) start = 2; // 0x / 0X
    uint64 v = 0;
    for (uint i = start; i < in.length(); i++)
    {
        int d = hex_val(in[i]);
        if (d < 0) break;
        v = (v << 4) | uint64(d);
    }
    return v;
}

array<uint8> parse_hex_bytes(const string &in in)
{
    uint start = 0;
    if (in.length() >= 2 && in[0] == 0x30 && (in[1] == 0x78 || in[1] == 0x58)) start = 2;
    array<uint8> out;
    for (uint i = start; i + 1 < in.length(); i += 2)
    {
        int hi = hex_val(in[i]);
        int lo = hex_val(in[i + 1]);
        if (hi < 0 || lo < 0) break;
        out.insertLast(uint8((hi << 4) | lo));
    }
    return out;
}

// Echo the request id verbatim (as digits) so the browser's AxClient matches the reply.
string extract_id(const string &in s)
{
    int p = s.findFirst("\"id\"");
    if (p < 0) return "0";
    int c = s.findFirst(":", p + 4);
    if (c < 0) return "0";
    uint i = uint(c) + 1;
    while (i < s.length() && s[i] == 0x20) i++; // skip spaces
    uint j = i;
    while (j < s.length())
    {
        uint8 ch = s[j];
        if (ch < 0x30 || ch > 0x39) break;
        j++;
    }
    if (j == i) return "0";
    return s.substr(i, int(j - i));
}

// Read a string field's value. Returns `def` when the key is absent. Assumes our values
// (hex, module names, paths) contain no embedded double-quote.
string json_str(const string &in s, const string &in key, const string &in def)
{
    string needle = "\"" + key + "\"";
    int p = s.findFirst(needle);
    if (p < 0) return def;
    int c = s.findFirst(":", p + int(needle.length()));
    if (c < 0) return def;
    int q1 = s.findFirst("\"", c);
    if (q1 < 0) return def;
    int q2 = s.findFirst("\"", q1 + 1);
    if (q2 < 0) return def;
    return s.substr(q1 + 1, q2 - q1 - 1);
}

// Read a bare (unquoted) numeric field, e.g. `"length":4096`. Returns `def` when absent.
uint64 json_num(const string &in s, const string &in key, uint64 def)
{
    string needle = "\"" + key + "\"";
    int p = s.findFirst(needle);
    if (p < 0) return def;
    int c = s.findFirst(":", p + int(needle.length()));
    if (c < 0) return def;
    uint i = uint(c) + 1;
    while (i < s.length() && s[i] == 0x20) i++;
    uint j = i;
    bool any = false;
    uint64 v = 0;
    while (j < s.length())
    {
        uint8 ch = s[j];
        if (ch < 0x30 || ch > 0x39) break;
        v = v * 10 + uint64(ch - 0x30);
        any = true;
        j++;
    }
    if (!any) return def;
    return v;
}

bool json_has(const string &in s, const string &in key)
{
    return s.findFirst("\"" + key + "\"") >= 0;
}

string json_escape(const string &in in)
{
    string out = "";
    for (uint i = 0; i < in.length(); i++)
    {
        uint8 ch = in[i];
        if (ch == 0x22 || ch == 0x5C) { out += "\\"; out += in.substr(i, 1); }   // " or \
        else if (ch < 0x20) { /* drop control chars */ }
        else out += in.substr(i, 1);
    }
    return out;
}

string bool_str(bool b) { return b ? "true" : "false"; }

// Format an address to match the frontend's hexAddr schema exactly: lowercase, "0x"-prefixed,
// unpadded, and "0x0" for zero. We do NOT use util::to_hex here because its case/prefix are
// host-defined and the Zod regex /^0x[0-9a-f]+$/ rejects uppercase or a missing prefix — a
// single mismatch would silently fail validation on every exports/imports/write frame.
string hex_addr(uint64 v)
{
    if (v == 0) return "0x0";
    const string digits = "0123456789abcdef";
    string s = "";
    while (v != 0)
    {
        s = digits.substr(int(v & 0xF), 1) + s;
        v >>= 4;
    }
    return "0x" + s;
}

// --- typed reads synthesized from read_uint64 -------------------------------

uint64 rd_u64(uint64 a) { return process::read_uint64(a); }
uint32 rd_u32(uint64 a) { return uint32(process::read_uint64(a) & 0xFFFFFFFF); }
uint16 rd_u16(uint64 a) { return uint16(process::read_uint64(a) & 0xFFFF); }

// Decimal string of a uint64. String-concatenating a raw uint64 is not guaranteed by the string
// addon, and region sizes can exceed 2^32 (large reserved ranges), so format it by hand.
string dec_u64(uint64 v)
{
    if (v == 0) return "0";
    const string digits = "0123456789";
    string s = "";
    while (v != 0)
    {
        s = digits.substr(int(v % 10), 1) + s;
        v /= 10;
    }
    return s;
}

void send_error(const string &in id, int code, const string &in message)
{
    ws::send("{\"type\":\"error\",\"id\":" + id +
             ",\"code\":" + code +
             ",\"message\":\"" + json_escape(message) + "\"}");
}

bool ready() { return g_attached && process::is_alive(); }

// --- verb handlers: write / dump --------------------------------------------

void handle_write(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    uint64 addr = parse_u64_hex(json_str(frame, "address", "0x0"));
    array<uint8> bytes = parse_hex_bytes(json_str(frame, "data", ""));
    bool ok = false;
    if (addr != 0 && bytes.length() > 0)
        ok = process::write_bytes(bytes, addr);

    ws::send("{\"type\":\"write_result\",\"id\":" + id +
             ",\"success\":" + bool_str(ok) +
             ",\"address\":\"" + hex_addr(addr) + "\"" +
             ",\"bytes_written\":" + (ok ? bytes.length() : uint(0)) + "}");
}

void handle_dump(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    string mod = json_str(frame, "module", "");
    string path = json_str(frame, "path", "");
    if (path == "") path = (mod != "" ? mod : "process") + "_dump.bin";

    bool ok = (mod != "") ? process::dump(mod, path) : process::dump(path);
    ws::send("{\"type\":\"dump_result\",\"id\":" + id +
             ",\"success\":" + bool_str(ok) +
             ",\"path\":\"" + json_escape(path) + "\"}");
}

// Resolve the module base + its name (defaults to the main process module).
uint64 module_base_for(const string &in frame, string &out name)
{
    name = json_str(frame, "module", "");
    if (name == "") name = PROCESS_NAME;
    return process::get_module_base(name);
}

// Locate DataDirectory[index] (RVA, size) for a PE32+ image at `base`.
// Returns the directory RVA; writes its size to `outSize`. 0 if unreadable.
uint32 data_directory(uint64 base, uint index, uint32 &out outSize)
{
    outSize = 0;
    uint32 e_lfanew = rd_u32(base + 0x3C);
    uint64 nt = base + e_lfanew;
    if (rd_u32(nt) != 0x00004550) return 0; // "PE\0\0"
    // OptionalHeader starts at nt+0x18; PE32+ DataDirectory begins at OptionalHeader+0x70.
    uint64 dir = nt + 0x18 + 0x70 + uint64(index) * 8;
    uint32 rva = rd_u32(dir);
    outSize = rd_u32(dir + 4);
    return rva;
}

void handle_exports(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    string mod;
    uint64 base = module_base_for(frame, mod);
    if (base == 0) { send_error(id, 1003, "module not found: " + mod); return; }

    uint32 dirSize;
    uint32 expRva = data_directory(base, 0, dirSize);
    if (expRva == 0) { send_error(id, 1010, "no export directory"); return; }

    uint64 exp = base + expRva;
    uint32 ordinalBase = rd_u32(exp + 0x10);
    uint32 numNames = rd_u32(exp + 0x18);
    uint32 addrFuncs = rd_u32(exp + 0x1C);
    uint32 addrNames = rd_u32(exp + 0x20);
    uint32 addrOrds = rd_u32(exp + 0x24);
    if (numNames > MAX_EXPORT_NAMES) numNames = MAX_EXPORT_NAMES;

    string rows = "";
    uint count = 0;
    for (uint i = 0; i < numNames; i++)
    {
        uint32 nameRva = rd_u32(base + addrNames + i * 4);
        if (nameRva == 0) continue;
        string name = process::read_string(base + nameRva);
        if (name == "") continue;
        uint16 ord = rd_u16(base + addrOrds + i * 2);
        uint32 funcRva = rd_u32(base + addrFuncs + uint32(ord) * 4);
        uint64 addr = base + funcRva;
        if (count > 0) rows += ",";
        rows += "{\"name\":\"" + json_escape(name) +
                "\",\"address\":\"" + hex_addr(addr) +
                "\",\"ordinal\":" + (uint32(ord) + ordinalBase) + "}";
        count++;
    }

    ws::send("{\"type\":\"exports_result\",\"id\":" + id +
             ",\"success\":true,\"module\":\"" + json_escape(mod) +
             "\",\"count\":" + count + ",\"results\":[" + rows + "]}");
}

void handle_imports(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    string mod;
    uint64 base = module_base_for(frame, mod);
    if (base == 0) { send_error(id, 1003, "module not found: " + mod); return; }

    uint32 dirSize;
    uint32 impRva = data_directory(base, 1, dirSize);
    if (impRva == 0) { send_error(id, 1010, "no import directory"); return; }

    string rows = "";
    uint count = 0;
    for (uint d = 0; d < MAX_IMPORT_DESCRIPTORS; d++)
    {
        uint64 desc = base + impRva + uint64(d) * 20;
        uint32 oft = rd_u32(desc + 0x00);       // OriginalFirstThunk (INT)
        uint32 nameRva = rd_u32(desc + 0x0C);   // DLL name RVA
        uint32 ft = rd_u32(desc + 0x10);        // FirstThunk (IAT)
        if (nameRva == 0 && oft == 0 && ft == 0) break; // null terminator descriptor
        if (nameRva == 0) continue;
        string dll = process::read_string(base + nameRva);
        // Prefer the Import Name Table (OriginalFirstThunk); fall back to the IAT only if the
        // module was built without an INT. Note: for an already-loaded module with oft==0 the
        // IAT holds resolved pointers, so imported-by-name resolution below may be inaccurate
        // for such (rare, bound/packed) modules — names for the common oft!=0 case are exact.
        uint32 intRva = (oft != 0) ? oft : ft;

        for (uint k = 0; k < MAX_IMPORT_THUNKS; k++)
        {
            uint64 thunk = rd_u64(base + intRva + uint64(k) * 8);
            if (thunk == 0) break;
            uint64 iatSlot = base + ft + uint64(k) * 8;
            string name;
            if ((thunk & 0x8000000000000000) != 0)
                name = "#" + (thunk & 0xFFFF);                 // import by ordinal
            else
                name = process::read_string(base + (thunk & 0x7FFFFFFF) + 2); // skip Hint (2 bytes)

            if (count > 0) rows += ",";
            rows += "{\"module\":\"" + json_escape(dll) +
                    "\",\"name\":\"" + json_escape(name) +
                    "\",\"iat\":\"" + hex_addr(iatSlot) + "\"}";
            count++;
        }
    }

    ws::send("{\"type\":\"imports_result\",\"id\":" + id +
             ",\"success\":true,\"module\":\"" + json_escape(mod) +
             "\",\"count\":" + count + ",\"results\":[" + rows + "]}");
}

// --- IAT rebuild / import reconstruction (for dumps) ------------------------
// Same walk as handle_imports but also emits the IAT slot's RVA (relative to `base`) and the
// resolved-thunk RVA (0 for bound/ordinal-only imports), so a dump-repair tool can rewrite a
// dumped image's IAT slots to point at the original thunk data without re-deriving RVAs itself.
void handle_iat_rebuild(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    string mod;
    uint64 base = module_base_for(frame, mod);
    if (base == 0) { send_error(id, 1003, "module not found: " + mod); return; }

    uint32 dirSize;
    uint32 impRva = data_directory(base, 1, dirSize);
    if (impRva == 0) { send_error(id, 1010, "no import directory"); return; }

    string rows = "";
    uint count = 0;
    for (uint d = 0; d < MAX_IMPORT_DESCRIPTORS; d++)
    {
        uint64 desc = base + impRva + uint64(d) * 20;
        uint32 oft = rd_u32(desc + 0x00);
        uint32 nameRva = rd_u32(desc + 0x0C);
        uint32 ft = rd_u32(desc + 0x10);
        if (nameRva == 0 && oft == 0 && ft == 0) break;
        if (nameRva == 0) continue;
        string dll = process::read_string(base + nameRva);
        uint32 intRva = (oft != 0) ? oft : ft;

        for (uint k = 0; k < MAX_IMPORT_THUNKS; k++)
        {
            uint64 thunk = rd_u64(base + intRva + uint64(k) * 8);
            if (thunk == 0) break;
            uint32 iatSlotRva = ft + k * 8;
            bool byOrdinal = (thunk & 0x8000000000000000) != 0;
            string name;
            uint32 nameThunkRva = 0;
            uint16 ordinal = 0;
            if (byOrdinal)
            {
                ordinal = uint16(thunk & 0xFFFF);
                name = "#" + ordinal;
            }
            else
            {
                nameThunkRva = uint32(thunk & 0x7FFFFFFF);
                name = process::read_string(base + uint64(nameThunkRva) + 2);
            }

            if (count > 0) rows += ",";
            rows += "{\"module\":\"" + json_escape(dll) +
                    "\",\"name\":\"" + json_escape(name) +
                    "\",\"by_ordinal\":" + bool_str(byOrdinal) +
                    ",\"ordinal\":" + ordinal +
                    ",\"iat\":\"" + hex_addr(base + uint64(iatSlotRva)) +
                    "\",\"iat_rva\":\"" + hex_addr(uint64(iatSlotRva)) +
                    "\",\"thunk_rva\":\"" + hex_addr(uint64(nameThunkRva)) +
                    "\",\"resolved\":\"" + hex_addr(rd_u64(base + uint64(ft) + uint64(k) * 8)) + "\"}";
            count++;
        }
    }

    ws::send("{\"type\":\"iat_rebuild_result\",\"id\":" + id +
             ",\"success\":true,\"module\":\"" + json_escape(mod) +
             "\",\"count\":" + count + ",\"results\":[" + rows + "]}");
}

// Read an 8-byte, possibly non-null-terminated section name from `at`.
string read_section_name(uint64 at)
{
    uint64 v = process::read_uint64(at);
    string s = "";
    string ch = " ";
    for (uint k = 0; k < 8; k++)
    {
        uint8 c = uint8((v >> (k * 8)) & 0xFF);
        if (c == 0) break;
        if (c < 0x20 || c > 0x7E) continue; // skip non-printable padding
        ch[0] = c;
        s += ch;
    }
    return s;
}

void handle_sections(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    string mod;
    uint64 base = module_base_for(frame, mod);
    if (base == 0) { send_error(id, 1003, "module not found: " + mod); return; }

    uint32 e_lfanew = rd_u32(base + 0x3C);
    uint64 nt = base + e_lfanew;
    if (rd_u32(nt) != 0x00004550) { send_error(id, 1010, "bad PE header"); return; }

    uint16 numSections = rd_u16(nt + 6);        // IMAGE_FILE_HEADER.NumberOfSections
    uint16 sizeOpt = rd_u16(nt + 20);           // IMAGE_FILE_HEADER.SizeOfOptionalHeader
    uint64 sec = nt + 24 + uint64(sizeOpt);     // first IMAGE_SECTION_HEADER
    if (numSections > 96) numSections = 96;     // PE hard limit is 96

    string rows = "";
    uint count = 0;
    for (uint i = 0; i < numSections; i++)
    {
        uint64 s = sec + uint64(i) * 40;        // section headers are 40 bytes each
        string name = read_section_name(s);
        uint32 vsize = rd_u32(s + 8);
        uint32 vaddr = rd_u32(s + 12);
        uint32 rawSize = rd_u32(s + 16);
        uint32 chars = rd_u32(s + 36);

        string prot = "";
        if ((chars & 0x40000000) != 0) prot += "r"; // IMAGE_SCN_MEM_READ
        if ((chars & 0x80000000) != 0) prot += "w"; // IMAGE_SCN_MEM_WRITE
        if ((chars & 0x20000000) != 0) prot += "x"; // IMAGE_SCN_MEM_EXECUTE
        if (prot == "") prot = "-";

        if (count > 0) rows += ",";
        rows += "{\"name\":\"" + json_escape(name) +
                "\",\"address\":\"" + hex_addr(base + vaddr) +
                "\",\"size\":" + vsize +
                ",\"raw_size\":" + rawSize +
                ",\"characteristics\":" + chars +
                ",\"protect\":\"" + prot + "\"}";
        count++;
    }

    ws::send("{\"type\":\"sections_result\",\"id\":" + id +
             ",\"success\":true,\"module\":\"" + json_escape(mod) +
             "\",\"count\":" + count + ",\"results\":[" + rows + "]}");
}

// PE header inspector: entry point, timestamp, subsystem, characteristics, checksum,
// image base/size. Mirrors handle_sections' header walk.
void handle_pe_header(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    string mod;
    uint64 base = module_base_for(frame, mod);
    if (base == 0) { send_error(id, 1003, "module not found: " + mod); return; }

    uint32 e_lfanew = rd_u32(base + 0x3C);
    uint64 nt = base + uint64(e_lfanew);
    if (rd_u32(nt) != 0x00004550) { send_error(id, 1010, "bad PE header"); return; }

    uint16 machine         = rd_u16(nt + 4);
    uint16 numSections     = rd_u16(nt + 6);
    uint32 timestamp       = rd_u32(nt + 8);
    uint16 characteristics = rd_u16(nt + 0x16);
    uint16 magic           = rd_u16(nt + 0x18);   // 0x20b = PE32+
    uint32 entryRva        = rd_u32(nt + 0x28);
    uint64 imageBase       = rd_u64(nt + 0x30);   // PE32+ ImageBase is 8 bytes
    uint32 sizeOfImage     = rd_u32(nt + 0x50);
    uint32 checksum        = rd_u32(nt + 0x58);
    uint16 subsystem       = rd_u16(nt + 0x5C);
    uint16 dllChar         = rd_u16(nt + 0x5E);

    ws::send("{\"type\":\"pe_header_result\",\"id\":" + id +
             ",\"success\":true,\"module\":\"" + json_escape(mod) +
             "\",\"machine\":" + machine +
             ",\"magic\":" + magic +
             ",\"num_sections\":" + numSections +
             ",\"timestamp\":" + timestamp +
             ",\"characteristics\":" + characteristics +
             ",\"subsystem\":" + subsystem +
             ",\"dll_characteristics\":" + dllChar +
             ",\"checksum\":" + checksum +
             ",\"size_of_image\":" + sizeOfImage +
             ",\"entry_point\":\"" + hex_addr(base + uint64(entryRva)) +
             "\",\"image_base\":\"" + hex_addr(imageBase) + "\"}");
}

// PE data-directory overview: the 16 optional-header directories (Export/Import/Resource/Reloc/
// TLS/Debug/LoadConfig/…) as name + RVA + absolute address + size. Absent directories skipped.
void handle_pe_dirs(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    string mod;
    uint64 base = module_base_for(frame, mod);
    if (base == 0) { send_error(id, 1003, "module not found: " + mod); return; }

    array<string> names = {
        "Export", "Import", "Resource", "Exception", "Security", "BaseReloc", "Debug",
        "Architecture", "GlobalPtr", "TLS", "LoadConfig", "BoundImport", "IAT", "DelayImport",
        "CLR", "Reserved"
    };
    string rows = "";
    uint count = 0;
    for (uint i = 0; i < 16; i++)
    {
        uint32 sz = 0;
        uint32 rva = data_directory(base, i, sz);
        if (rva == 0 && sz == 0) continue; // directory not present
        if (count > 0) rows += ",";
        rows += "{\"name\":\"" + names[i] +
                "\",\"rva\":\"" + hex_addr(uint64(rva)) +
                "\",\"address\":\"" + hex_addr(base + uint64(rva)) +
                "\",\"size\":" + sz + "}";
        count++;
    }
    ws::send("{\"type\":\"pe_dirs_result\",\"id\":" + id +
             ",\"success\":true,\"module\":\"" + json_escape(mod) +
             "\",\"count\":" + count + ",\"results\":[" + rows + "]}");
}

// --- resource tree -----------------------------------------------------------
// Nested IMAGE_RESOURCE_DIRECTORY walk (type -> name -> lang -> data). All offsets in the two
// directory levels are relative to the start of the resource section (`rsrcBase`); the final
// leaf's OffsetToData is a plain module-relative RVA (relative to `base`), per the PE spec.
const uint MAX_RES_ENTRIES = 20000; // hard cap across the whole tree walk
const uint MAX_RES_NAME_CHARS = 128;
uint g_res_emitted = 0;

// Best-effort UTF-16LE -> ASCII decode of a resource directory string (length-prefixed uint16
// char count at `at`, then that many UTF-16 code units). Non-ASCII code points are dropped;
// there is no confirmed wide-string decode call in this host.
string read_res_name(uint64 at)
{
    uint16 len = rd_u16(at);
    if (len > MAX_RES_NAME_CHARS) len = MAX_RES_NAME_CHARS;
    string s = "";
    string ch = " ";
    for (uint16 k = 0; k < len; k++)
    {
        uint16 u = rd_u16(at + 2 + uint64(k) * 2);
        uint8 c = uint8(u & 0xFF);
        if (u > 0xFF || c < 0x20 || c > 0x7E) continue;
        ch[0] = c;
        s += ch;
    }
    return s;
}

// Recursively emits one IMAGE_RESOURCE_DIRECTORY's entries as JSON. `depth` 0=type, 1=name,
// 2=lang (whose entries point at leaf IMAGE_RESOURCE_DATA_ENTRY structs, not sub-directories).
string walk_res_dir(uint64 base, uint64 rsrcBase, uint64 dirRva, uint depth)
{
    if (depth > 2 || g_res_emitted >= MAX_RES_ENTRIES) return "";
    uint64 dir = rsrcBase + dirRva;
    uint16 numNamed = rd_u16(dir + 12);
    uint16 numId = rd_u16(dir + 14);
    uint32 total = uint32(numNamed) + uint32(numId);
    if (total > 4096) total = 4096; // sanity cap per directory level

    string rows = "";
    uint emittedHere = 0;
    for (uint32 i = 0; i < total && g_res_emitted < MAX_RES_ENTRIES; i++)
    {
        uint64 entry = dir + 16 + uint64(i) * 8;
        uint32 nameField = rd_u32(entry);
        uint32 offsetField = rd_u32(entry + 4);
        bool named = (nameField & 0x80000000) != 0;
        string name = "";
        uint32 idVal = 0;
        if (named) name = read_res_name(rsrcBase + uint64(nameField & 0x7FFFFFFF));
        else idVal = nameField;

        bool isDir = (offsetField & 0x80000000) != 0;
        uint32 sub = offsetField & 0x7FFFFFFF;

        if (emittedHere > 0) rows += ",";
        g_res_emitted++;
        emittedHere++;

        if (isDir && depth < 2)
        {
            string children = walk_res_dir(base, rsrcBase, uint64(sub), depth + 1);
            rows += "{\"level\":" + depth + ",\"named\":" + bool_str(named) +
                    ",\"id\":" + idVal + ",\"name\":\"" + json_escape(name) +
                    "\",\"is_dir\":true,\"children\":[" + children + "]}";
        }
        else
        {
            // Leaf IMAGE_RESOURCE_DATA_ENTRY: OffsetToData (module RVA), Size, CodePage, Reserved.
            uint64 leaf = rsrcBase + uint64(sub);
            uint32 dataRva = rd_u32(leaf);
            uint32 dataSize = rd_u32(leaf + 4);
            uint32 codePage = rd_u32(leaf + 8);
            rows += "{\"level\":" + depth + ",\"named\":" + bool_str(named) +
                    ",\"id\":" + idVal + ",\"name\":\"" + json_escape(name) +
                    "\",\"is_dir\":false,\"address\":\"" + hex_addr(base + uint64(dataRva)) +
                    "\",\"size\":" + dataSize + ",\"code_page\":" + codePage + "}";
        }
    }
    return rows;
}

void handle_resource_tree(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    string mod;
    uint64 base = module_base_for(frame, mod);
    if (base == 0) { send_error(id, 1003, "module not found: " + mod); return; }

    uint32 dirSize;
    uint32 rsrcRva = data_directory(base, 2, dirSize); // IMAGE_DIRECTORY_ENTRY_RESOURCE
    if (rsrcRva == 0) { send_error(id, 1010, "no resource directory"); return; }

    g_res_emitted = 0;
    string tree = walk_res_dir(base, base + uint64(rsrcRva), 0, 0);

    ws::send("{\"type\":\"resource_tree_result\",\"id\":" + id +
             ",\"success\":true,\"module\":\"" + json_escape(mod) +
             "\",\"count\":" + g_res_emitted + ",\"results\":[" + tree + "]}");
}

// Bound the address-space walk so a pathological map (or a virtual_query that reports zero-size)
// can never spin forever. User-mode space tops out well under this ceiling.
const uint MAX_REGIONS = 8192;
const uint64 ADDR_SPACE_TOP = 0x7FFFFFFFFFFF; // top of the x64 user-mode range
const uint64 GALLOP_MAX_STRIDE = 0x40000000;  // 1 GB — cap on the free-space probe stride
const uint MAX_PROBES = 300000;               // total free-space probes per regions/scan call

// Short r/w/x string from a Windows PAGE_* protection constant, for at-a-glance display.
string protect_rwx(uint32 p)
{
    // Strip the modifier flags (PAGE_GUARD 0x100, NOCACHE 0x200, WRITECOMBINE 0x400) first.
    uint32 base = p & 0xFF;
    bool x = (base & 0xF0) != 0;                                   // any PAGE_EXECUTE*
    bool w = (base & 0x04) != 0 || (base & 0x08) != 0 || (base & 0x40) != 0 || (base & 0x80) != 0;
    bool r = w || x || (base & 0x02) != 0 || (base & 0x20) != 0;   // readable if any access at all
    string s = "";
    s += r ? "r" : "-";
    s += w ? "w" : "-";
    s += x ? "x" : "-";
    if ((p & 0x100) != 0) s += "g"; // guard page
    return s;
}

// Region map: walk the target's virtual address space via virtual_query, emitting every
// committed region (base, size, protection). Free ranges are skipped - they are the vast
// majority of the address space and carry no useful info. An optional `module` field scopes
// the walk to that module's mapped range.
//
// NOTE: this host's memory_region exposes ONLY {base,size,protect} — no `state`/`type`
// members. `state`/`type` are emitted as 0 to satisfy the frontend regions_result schema.
// process::get_module_size(base) takes the module BASE (uint64), not the name.
void handle_regions(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }

    // Optional module scope: restrict the walk to [modBase, modBase+modSize).
    string mod = json_str(frame, "module", "");
    uint64 lo = 0;
    uint64 hi = ADDR_SPACE_TOP;
    if (mod != "")
    {
        uint64 mb = process::get_module_base(mod);
        if (mb == 0) { send_error(id, 1003, "module not found: " + mod); return; }
        uint64 ms = process::get_module_size(mb); // takes the module BASE, not the name
        lo = mb;
        hi = (ms > 0) ? mb + ms : mb + 0x1000;
    }

    string rows = "";
    uint count = 0;
    uint64 addr = lo;
    for (uint guard = 0; guard < MAX_REGIONS && addr < hi; guard++)
    {
        memory_region rg = process::virtual_query(addr);
        // A zero-size result means the query failed at this address; step a page so the walk
        // always makes forward progress instead of stalling.
        if (rg.size == 0) { addr += 0x1000; continue; }

        // memory_region exposes only base/size/protect (no state/type), so filter on protection:
        // protect == 0 is PAGE_NOACCESS / free - skip it, emit only accessible regions. state and
        // type are emitted as 0 to keep the frontend regions_result schema satisfied.
        if (rg.protect != 0)
        {
            if (count > 0) rows += ",";
            rows += "{\"base\":\"" + hex_addr(rg.base) +
                    "\",\"size\":" + dec_u64(rg.size) +
                    ",\"protect\":" + dec_u64(uint64(rg.protect)) +
                    ",\"state\":0" +
                    ",\"type\":0" +
                    ",\"prot\":\"" + protect_rwx(rg.protect) + "\"}";
            count++;
        }

        uint64 next = rg.base + rg.size;
        addr = (next > addr) ? next : addr + 0x1000; // never regress
    }

    ws::send("{\"type\":\"regions_result\",\"id\":" + id +
             ",\"success\":true,\"module\":\"" + json_escape(mod) +
             "\",\"count\":" + count + ",\"results\":[" + rows + "]}");
}

// --- value scanner ------------------------------------------------------------
// A Cheat-Engine-style scanner. First scan reads the target scope in 1 MB chunks via
// read_buffer and collects every aligned candidate (either equal to a target value, or — for
// value_type "unknown" — every slot, unfiltered, to power an "unknown initial value" scan).
// Subsequent filter passes re-read only the surviving candidates with typed reads and keep those
// matching the operator, including a float-fuzzy "approx" op (|cur-cmp| <= epsilon). No
// find_signatures / dictionary in this host, so everything is hand-rolled over read_buffer +
// parallel arrays.
const uint64 SCAN_MAX_BYTES = 0x10000000;      // 256 MB cap on a single module first-scan sweep
const uint64 SCAN_PROC_MAX_BYTES = 0x20000000; // 512 MB total cap for a whole-process sweep
const uint   SCAN_MAX_CANDIDATES = 400000;     // stop collecting past this
const uint   SCAN_SAMPLE = 200;                // rows returned to the UI (full set stays here)
array<uint64> g_scan_addrs;    // candidate absolute addresses
array<uint64> g_scan_bits;     // each candidate's raw value bits at the last scan (for diff ops)
string        g_scan_vtype = ""; // "i32"|"u32"|"f32"|"i64"|"u64"|"unknown"; "" = no active scan
int           g_scan_width = 4;  // byte width of the scanned type

int type_width(const string &in t)
{
    if (t == "i32" || t == "u32" || t == "f32" || t == "unknown") return 4;
    if (t == "i64" || t == "u64") return 8;
    return 0; // 1/2-byte and f64 not scanned (step-1 sweeps too slow / no read_double)
}

// Decode raw IEEE-754 single bits to a float (no reinterpret_cast in AngelScript, and no
// bits->float host call is confirmed, so decode by hand). Inf/NaN clamp to a large magnitude.
float u32_as_float(uint32 u)
{
    uint sign = (u >> 31) & 1;
    int  exp  = int((u >> 23) & 0xFF);
    uint mant = u & 0x7FFFFF;
    if (exp == 0 && mant == 0) return 0.0f;
    float m;
    if (exp == 0) { m = float(mant) / 8388608.0f; exp = -126; }
    else if (exp == 0xFF) { return sign == 1 ? -1000000000.0f : 1000000000.0f; }
    else { m = 1.0f + float(mant) / 8388608.0f; exp = exp - 127; }
    float scale = 1.0f;
    if (exp >= 0) { for (int i = 0; i < exp; i++)  scale *= 2.0f; }
    else          { for (int i = 0; i < -exp; i++) scale /= 2.0f; }
    float val = m * scale;
    return sign == 1 ? -val : val;
}

// Read the raw value bits at addr for the active width (4-byte zero-extended, or 8-byte).
uint64 read_bits(uint64 addr, int width)
{
    if (width == 8) return process::read_uint64(addr);
    return uint64(process::read_uint32(addr));
}

// Typed ordering: is the value in `a` greater than the value in `b`, under type t?
bool val_gt(uint64 a, uint64 b, const string &in t)
{
    if (t == "f32") return u32_as_float(uint32(a & 0xFFFFFFFF)) > u32_as_float(uint32(b & 0xFFFFFFFF));
    if (t == "u64") return a > b;
    if (t == "i64")
    {
        bool an = ((a >> 63) & 1) != 0;
        bool bn = ((b >> 63) & 1) != 0;
        if (an != bn) return bn;   // a>=0 & b<0 -> a greater; a<0 & b>=0 -> not
        return a > b;              // same sign: unsigned order matches signed order
    }
    if (t == "u32" || t == "unknown") return (a & 0xFFFFFFFF) > (b & 0xFFFFFFFF);
    // i32: reinterpret low 32 bits via `int` (confirmed), which is 32-bit signed.
    return int(uint32(a & 0xFFFFFFFF)) > int(uint32(b & 0xFFFFFFFF));
}

// |a-b| for the active type, as a float (only meaningful for f32 "approx" filtering).
float val_abs_diff_f32(uint64 a, uint64 b)
{
    float fa = u32_as_float(uint32(a & 0xFFFFFFFF));
    float fb = u32_as_float(uint32(b & 0xFFFFFFFF));
    float d = fa - fb;
    return d < 0.0f ? -d : d;
}

// Self-contained float formatter (3 decimals) - avoids depending on the host's string+float
// to-string, which is not confirmed for this build.
string ff(float v)
{
    bool neg = v < 0.0f;
    if (neg) v = -v;
    uint64 ip = uint64(v);
    float frac = v - float(ip);
    uint64 fp = uint64(frac * 1000.0f + 0.5f);
    if (fp >= 1000) { fp -= 1000; ip += 1; } // rounding carried into the integer part
    string fs = dec_u64(fp);
    while (fs.length() < 3) fs = "0" + fs;
    return (neg ? "-" : "") + dec_u64(ip) + "." + fs;
}

// Format raw value bits as a decimal (or float) string for the JSON `value` field.
string val_str(uint64 bits, const string &in t)
{
    if (t == "f32") return ff(u32_as_float(uint32(bits & 0xFFFFFFFF)));
    if (t == "u64") return dec_u64(bits);
    if (t == "i64")
    {
        if (((bits >> 63) & 1) != 0) { uint64 mag = (~bits) + 1; return "-" + dec_u64(mag); }
        return dec_u64(bits);
    }
    if (t == "u32" || t == "unknown") return dec_u64(bits & 0xFFFFFFFF);
    // i32
    uint32 u = uint32(bits & 0xFFFFFFFF);
    if ((u & 0x80000000) != 0) { uint32 mag = uint32(0) - u; return "-" + dec_u64(uint64(mag)); }
    return dec_u64(uint64(u));
}

// Mask a raw target to the active width so 4-byte compares ignore the high dword.
uint64 mask_bits(uint64 bits, int width) { return width == 8 ? bits : (bits & 0xFFFFFFFF); }

// Emit a scan result frame: total surviving count plus a bounded sample of {address,value}.
void send_scan_result(const string &in id, const string &in resultType)
{
    uint total = g_scan_addrs.length();
    uint n = total < SCAN_SAMPLE ? total : SCAN_SAMPLE;
    string rows = "";
    for (uint i = 0; i < n; i++)
    {
        if (i > 0) rows += ",";
        rows += "{\"address\":\"" + hex_addr(g_scan_addrs[i]) +
                "\",\"value\":" + val_str(g_scan_bits[i], g_scan_vtype) + "}";
    }
    ws::send("{\"type\":\"" + resultType + "\",\"id\":" + id +
             ",\"success\":true,\"value_type\":\"" + g_scan_vtype +
             "\",\"count\":" + total + ",\"results\":[" + rows + "]}");
}

// Scan one contiguous range, appending candidates to the global arrays. When `filterByValue` is
// false (value_type "unknown"), every aligned slot in range is captured as a baseline snapshot —
// this is the "unknown initial value" scan mode; later scan_filter passes (changed/unchanged/
// increased/decreased) diff live memory against this snapshot. When true, only slots equal to
// the target are kept, exactly like a normal known-value first scan.
void scan_range(uint64 base, uint64 len, uint64 target, uint32 target32, int width,
                 uint64 targetMasked, bool filterByValue)
{
    uint64 chunk = 0x100000; // 1 MB
    uint64 off = 0;
    while (off < len && g_scan_addrs.length() < SCAN_MAX_CANDIDATES)
    {
        uint64 clen = (len - off < chunk) ? (len - off) : chunk;
        memory_buffer@ buf = process::read_buffer(base + off, clen);
        if (buf !is null && clen >= uint64(width))
        {
            uint64 lim = clen - uint64(width);
            for (uint64 o = 0; o <= lim; o += uint64(width))
            {
                uint64 bits = (width == 8) ? buf.read_uint64(o) : uint64(buf.read_uint32(o));
                bool hit = !filterByValue || (width == 8 ? bits == target : uint32(bits) == target32);
                if (hit)
                {
                    g_scan_addrs.insertLast(base + off + o);
                    g_scan_bits.insertLast(filterByValue ? targetMasked : bits);
                    if (g_scan_addrs.length() >= SCAN_MAX_CANDIDATES) return;
                }
            }
        }
        off += chunk;
    }
}

// Whole-process sweep: walk committed, readable regions (galloping over free space like the
// region map) and scan each until the byte budget or candidate cap is hit.
void scan_process(uint64 target, uint32 target32, int width, uint64 targetMasked, bool filterByValue)
{
    uint64 budget = SCAN_PROC_MAX_BYTES;
    uint64 addr = 0;
    uint probes = 0;
    for (uint guard = 0; guard < MAX_REGIONS && addr < ADDR_SPACE_TOP; guard++)
    {
        if (budget == 0 || g_scan_addrs.length() >= SCAN_MAX_CANDIDATES) break;
        memory_region rg = process::virtual_query(addr);
        if (rg.size == 0)
        {
            uint64 stride = 0x10000;
            uint64 probe = addr;
            bool found = false;
            while (probe < ADDR_SPACE_TOP && probes < MAX_PROBES)
            {
                probe += stride;
                probes++;
                memory_region pr = process::virtual_query(probe);
                if (pr.size != 0) { found = true; break; }
                if (stride < GALLOP_MAX_STRIDE) stride <<= 1;
            }
            if (!found) break;
            addr = (probe > addr) ? probe : addr + stride;
            continue;
        }
        // Readable and not a guard page (PAGE_NOACCESS=0x01, PAGE_GUARD=0x100).
        if (rg.protect != 0 && (rg.protect & 0x1) == 0 && (rg.protect & 0x100) == 0)
        {
            uint64 len = (rg.size < budget) ? rg.size : budget;
            scan_range(rg.base, len, target, target32, width, targetMasked, filterByValue);
            budget = (budget > rg.size) ? budget - rg.size : 0;
        }
        uint64 next = rg.base + rg.size;
        addr = (next > addr) ? next : addr + 0x10000;
    }
}

void handle_scan_new(const string &in frame, const string &in id)
{
    if (!ready()) { send_error(id, 1001, "not attached"); return; }
    string vtype = json_str(frame, "value_type", "i32");
    int width = type_width(vtype);
    if (width == 0) { send_error(id, 1020, "unsupported value type: " + vtype); return; }
    bool unknown = (vtype == "unknown");
    uint64 target = unknown ? 0 : parse_u64_hex(json_str(frame, "value_hex", "0x0"));
    uint64 targetMasked = mask_bits(target, width);
    uint32 target32 = uint32(target & 0xFFFFFFFF);

    g_scan_addrs.resize(0);
    g_scan_bits.resize(0);
    g_scan_vtype = vtype;
    g_scan_width = width;

    // scope "process" sweeps committed heap/stack/image regions; otherwise a single module image.
    string scope = json_str(frame, "scope", "module");
    if (scope == "process")
    {
        scan_process(target, target32, width, targetMasked, !unknown);
    }
    else
    {
        string mod = json_str(frame, "module", "");
        if (mod == "") mod = PROCESS_NAME;
        uint64 base = process::get_module_base(mod);
        if (base == 0) { send_error(id, 1003, "module not found: " + mod); return; }
        uint64 msize = process::get_module_size(base);
        if (msize == 0) { send_error(id, 1021, "module size unavailable"); return; }
        if (msize > SCAN_MAX_BYTES) msize = SCAN_MAX_BYTES;
        scan_range(base, msize, target, target32, width, targetMasked, !unknown);
    }

    send_scan_result(id, "scan_new_result");
}

void handle_scan_filter(const string &in frame, const string &in id)
{
    if (!ready()) { send_error(id, 1001, "not attached"); return; }
    if (g_scan_vtype == "") { send_error(id, 1022, "no active scan - run scan_new first"); return; }

    string op = json_str(frame, "op", "unchanged");
    bool hasVal = json_has(frame, "value_hex");
    uint64 cmp = hasVal ? mask_bits(parse_u64_hex(json_str(frame, "value_hex", "0x0")), g_scan_width) : 0;
    // Epsilon for the fuzzy float "approx" op, as a hex-encoded float32 bit pattern (same
    // encoding as value_hex) so we never depend on a confirmed string->float parse.
    float epsilon = 0.01f;
    if (json_has(frame, "epsilon_hex"))
        epsilon = u32_as_float(uint32(parse_u64_hex(json_str(frame, "epsilon_hex", "0x0")) & 0xFFFFFFFF));

    array<uint64> keepA;
    array<uint64> keepB;
    for (uint i = 0; i < g_scan_addrs.length(); i++)
    {
        uint64 cur  = read_bits(g_scan_addrs[i], g_scan_width);
        uint64 prev = g_scan_bits[i];
        bool keep = false;
        if      (op == "unchanged") keep = (cur == prev);
        else if (op == "changed")   keep = (cur != prev);
        else if (op == "increased") keep = val_gt(cur, prev, g_scan_vtype);
        else if (op == "decreased") keep = val_gt(prev, cur, g_scan_vtype);
        else if (op == "eq")        keep = hasVal && (cur == cmp);
        else if (op == "gt")        keep = hasVal && val_gt(cur, cmp, g_scan_vtype);
        else if (op == "lt")        keep = hasVal && val_gt(cmp, cur, g_scan_vtype);
        else if (op == "approx")    keep = (g_scan_vtype == "f32") && val_abs_diff_f32(cur, hasVal ? cmp : prev) <= epsilon;
        if (keep) { keepA.insertLast(g_scan_addrs[i]); keepB.insertLast(cur); }
    }
    g_scan_addrs = keepA;
    g_scan_bits = keepB;
    send_scan_result(id, "scan_filter_result");
}

void handle_scan_clear(const string &in frame, const string &in id)
{
    g_scan_addrs.resize(0);
    g_scan_bits.resize(0);
    g_scan_vtype = "";
    ws::send("{\"type\":\"scan_clear_result\",\"id\":" + id + ",\"success\":true,\"count\":0,\"results\":[]}");
}

// Grouped scan: for each of the first N current scan candidates, read a small window of
// aligned uint32 slots around it (offsets in [-window,+window]) — struct-adjacent values, so a
// UI can spot "score at +0x10 next to health at +0x0" style groupings without a manual pointer
// chain per field. Operates on the CURRENT candidate set from the last scan_new/scan_filter.
const uint SCAN_GROUP_MAX_HITS = 50;    // bound how many candidates get a window (keeps replies small)
const uint SCAN_GROUP_MAX_WINDOW = 256; // bytes each side, hard cap

void handle_scan_grouped(const string &in frame, const string &in id)
{
    if (!ready()) { send_error(id, 1001, "not attached"); return; }
    if (g_scan_addrs.length() == 0) { send_error(id, 1022, "no active scan candidates"); return; }

    uint window = uint(json_num(frame, "window", 32));
    if (window > SCAN_GROUP_MAX_WINDOW) window = SCAN_GROUP_MAX_WINDOW;
    if (window < 4) window = 4;
    uint step = 4; // aligned uint32 slots only (matches the confirmed-safe read_uint32 call)

    uint n = g_scan_addrs.length();
    if (n > SCAN_GROUP_MAX_HITS) n = SCAN_GROUP_MAX_HITS;

    string groups = "";
    for (uint i = 0; i < n; i++)
    {
        uint64 hitAddr = g_scan_addrs[i];
        uint64 winStart = (hitAddr > uint64(window)) ? hitAddr - uint64(window) : 0;
        string slots = "";
        bool first = true;
        for (uint64 a = winStart; a <= hitAddr + uint64(window); a += uint64(step))
        {
            if (!first) slots += ",";
            first = false;
            int off = int(int64(a) - int64(hitAddr));
            uint32 v = process::read_uint32(a);
            slots += "{\"offset\":" + off + ",\"address\":\"" + hex_addr(a) +
                     "\",\"value_u32\":" + v + "}";
        }
        if (i > 0) groups += ",";
        groups += "{\"hit\":\"" + hex_addr(hitAddr) + "\",\"slots\":[" + slots + "]}";
    }

    ws::send("{\"type\":\"scan_grouped_result\",\"id\":" + id +
             ",\"success\":true,\"count\":" + n + ",\"results\":[" + groups + "]}");
}

// --- bounded raw byte / IDA-style pattern scan --------------------------------
// Scans a caller-specified [address,length) range for a byte pattern with "??" wildcard bytes
// (space-separated hex, e.g. "48 8B ?? ?? E8"), via chunked read_buffer + manual compare — no
// find_signatures in this host. Overlaps each 1 MB chunk by (pattern length - 1) bytes so a match
// straddling a chunk boundary is never missed.
const uint RAW_SCAN_MAX_LEN = 0x8000000;  // 128 MB hard cap on the scanned range
const uint RAW_SCAN_MAX_HITS = 5000;
const uint RAW_SCAN_MAX_PATTERN = 256;

// Parse an IDA-style pattern string into byte values + a wildcard mask (true = wildcard).
// Accepts "?" or "??" as a wildcard token; any other pair of hex digits is a literal byte.
void parse_pattern(const string &in pat, array<uint8> &out bytes, array<bool> &out wild)
{
    uint i = 0;
    while (i < pat.length() && bytes.length() < RAW_SCAN_MAX_PATTERN)
    {
        while (i < pat.length() && pat[i] == 0x20) i++; // skip spaces
        if (i >= pat.length()) break;
        if (pat[i] == 0x3F) // '?'
        {
            bytes.insertLast(0);
            wild.insertLast(true);
            i++;
            if (i < pat.length() && pat[i] == 0x3F) i++; // optional second '?'
            continue;
        }
        if (i + 1 >= pat.length()) break;
        int hi = hex_val(pat[i]);
        int lo = hex_val(pat[i + 1]);
        if (hi < 0 || lo < 0) break;
        bytes.insertLast(uint8((hi << 4) | lo));
        wild.insertLast(false);
        i += 2;
    }
}

void handle_raw_scan(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { send_error(id, 1001, "not attached"); return; }
    uint64 addr = parse_u64_hex(json_str(frame, "address", "0x0"));
    uint64 len = json_num(frame, "length", 0);
    if (addr == 0 || len == 0) { send_error(id, 1002, "address and length are required"); return; }
    if (len > uint64(RAW_SCAN_MAX_LEN)) len = uint64(RAW_SCAN_MAX_LEN);

    array<uint8> bytes;
    array<bool> wild;
    parse_pattern(json_str(frame, "pattern", ""), bytes, wild);
    uint plen = bytes.length();
    if (plen == 0) { send_error(id, 1023, "empty/invalid pattern"); return; }

    string rows = "";
    uint count = 0;
    uint64 chunk = 0x100000; // 1 MB
    uint64 overlap = uint64(plen - 1);
    uint64 off = 0;
    while (off < len && count < RAW_SCAN_MAX_HITS)
    {
        uint64 readStart = (off > overlap) ? off - overlap : 0; // re-cover the previous tail
        uint64 remain = len - readStart;
        uint64 clen = (remain < chunk) ? remain : chunk;
        memory_buffer@ buf = process::read_buffer(addr + readStart, clen);
        if (buf !is null && clen >= uint64(plen))
        {
            uint64 lim = clen - uint64(plen);
            for (uint64 o = 0; o <= lim && count < RAW_SCAN_MAX_HITS; o++)
            {
                uint64 absOff = readStart + o;
                if (absOff < off) continue;        // already emitted in a prior chunk's core range
                if (absOff >= off + chunk) break;   // belongs to the next chunk's core range
                bool match = true;
                for (uint k = 0; k < plen; k++)
                {
                    if (wild[k]) continue;
                    // read one byte via a masked uint32 read at (o+k) rounded down is not available;
                    // memory_buffer only exposes read_uint32/read_uint64, so read a 4-byte window
                    // and extract the low byte to stay within the confirmed-safe API surface.
                    uint32 word = buf.read_uint32(o + k);
                    uint8 b = uint8(word & 0xFF);
                    if (b != bytes[k]) { match = false; break; }
                }
                if (match)
                {
                    if (count > 0) rows += ",";
                    rows += "\"" + hex_addr(addr + absOff) + "\"";
                    count++;
                }
            }
        }
        off += chunk;
    }

    ws::send("{\"type\":\"raw_scan_result\",\"id\":" + id +
             ",\"success\":true,\"address\":\"" + hex_addr(addr) +
             "\",\"length\":" + dec_u64(len) +
             ",\"count\":" + count + ",\"results\":[" + rows + "]}");
}

// --- Unicorn emulator (offline / process-backed emulation) --------------------
// Offline x86-64 emulation via Angel's documented uc:: API. This is an EMULATOR, never a debugger:
// uc::create_process() demand-loads pages from the attached process, but all subsequent state lives
// in Unicorn and the target process is never modified. Execution is always bounded — uc::start()
// takes an instruction count AND a microsecond timeout, and the code hook returns false to stop —
// so Run/Step can never run away. One session at a time; a new session closes the previous handle.

uint64 g_emu = 0;                 // current Unicorn handle (0 = none)
string g_emu_session = "";        // opaque session id assigned by the frontend
int    g_emu_gen = -1;            // target generation captured at create (frontend supplies it)
string g_emu_mode = "";           // "process" | "standalone"
uint64 g_emu_entry = 0;           // configured entry address
uint64 g_emu_stop = 0;            // configured stop address (0 = none)
uint64 g_emu_stack_base = 0;
uint64 g_emu_stack_size = 0;
uint64 g_emu_rip = 0;             // last observed rip (updated by the hook)
uint64 g_emu_insn_total = 0;      // instructions executed across this session's runs
string g_emu_status = "closed";   // idle|creating|ready|running|completed|faulted|closed
bool   g_emu_hook_installed = false;

// Stored create config so reset() can rebuild the exact initial state.
array<string> g_emu_init_reg_names;
array<uint64> g_emu_init_reg_vals;
array<uint64> g_emu_breakpoints;
bool   g_emu_trace_on = true;
bool   g_emu_bytes_on = true;

// Per-run trace buffers (bounded; filled by the hook, serialized after uc::start returns).
array<uint64> g_tr_addr;
array<uint>   g_tr_size;
array<string> g_tr_bytes;
uint   g_tr_limit = EMU_TRACE_LIMIT_DEFAULT;
uint   g_tr_dropped = 0;
uint64 g_run_budget = 0;
uint64 g_run_count = 0;
bool   g_hit_bp = false;
uint64 g_bp_addr = 0;

string emu_bytes_hex(const array<uint8> &in b)
{
    const string digits = "0123456789abcdef";
    string s = "";
    for (uint i = 0; i < b.length(); i++)
    {
        uint8 c = b[i];
        s += digits.substr((c >> 4) & 0xF, 1);
        s += digits.substr(c & 0xF, 1);
    }
    return s;
}

// Split a comma-separated string into tokens (empty input -> empty array). Used for the flat reg /
// breakpoint / mapping encodings so we never depend on a nested-JSON parser this host lacks.
array<string> emu_split(const string &in s)
{
    array<string> out;
    if (s.length() == 0) return out;
    int start = 0;
    for (uint i = 0; i <= s.length(); i++)
    {
        if (i == s.length() || s[i] == 0x2C) // ','
        {
            if (int(i) > start) out.insertLast(s.substr(start, int(i) - start));
            start = int(i) + 1;
        }
    }
    return out;
}

// Map a register name to its x86_reg enum. Returns false for unknown / unsupported names (SIMD /
// segment / control registers are deliberately NOT exposed this phase).
bool emu_reg(const string &in n, x86_reg &out r)
{
    if (n == "rax") { r = x86_reg::rax; return true; }
    if (n == "rbx") { r = x86_reg::rbx; return true; }
    if (n == "rcx") { r = x86_reg::rcx; return true; }
    if (n == "rdx") { r = x86_reg::rdx; return true; }
    if (n == "rsi") { r = x86_reg::rsi; return true; }
    if (n == "rdi") { r = x86_reg::rdi; return true; }
    if (n == "rbp") { r = x86_reg::rbp; return true; }
    if (n == "rsp") { r = x86_reg::rsp; return true; }
    if (n == "rip") { r = x86_reg::rip; return true; }
    if (n == "eflags") { r = x86_reg::eflags; return true; }
    if (n == "r8")  { r = x86_reg::r8;  return true; }
    if (n == "r9")  { r = x86_reg::r9;  return true; }
    if (n == "r10") { r = x86_reg::r10; return true; }
    if (n == "r11") { r = x86_reg::r11; return true; }
    if (n == "r12") { r = x86_reg::r12; return true; }
    if (n == "r13") { r = x86_reg::r13; return true; }
    if (n == "r14") { r = x86_reg::r14; return true; }
    if (n == "r15") { r = x86_reg::r15; return true; }
    return false;
}

array<string> emu_reg_names()
{
    array<string> n = { "rax","rbx","rcx","rdx","rsi","rdi","rbp","rsp","rip","eflags",
                        "r8","r9","r10","r11","r12","r13","r14","r15" };
    return n;
}

// Serialize all supported registers as a JSON object of name -> hex string.
string emu_registers_json()
{
    array<string> names = emu_reg_names();
    string out = "";
    for (uint i = 0; i < names.length(); i++)
    {
        x86_reg r;
        if (!emu_reg(names[i], r)) continue;
        uint64 v = 0;
        uc::reg_read64(g_emu, r, v);
        if (out.length() > 0) out += ",";
        out += "\"" + names[i] + "\":\"" + hex_addr(v) + "\"";
    }
    return "{" + out + "}";
}

// The code hook: fires per emulated instruction. Records a bounded trace, enforces the instruction
// budget, and stops at an emulation breakpoint. Returning false halts uc::start deterministically.
bool on_emu_code(uint64 h, uint64 address, uint32 size)
{
    g_emu_rip = address;

    // Emulation breakpoint — skip the very first instruction of a run so a paused-on-breakpoint
    // session can resume past it.
    if (g_run_count > 0)
    {
        for (uint i = 0; i < g_emu_breakpoints.length(); i++)
        {
            if (g_emu_breakpoints[i] == address) { g_hit_bp = true; g_bp_addr = address; return false; }
        }
    }

    if (g_emu_trace_on)
    {
        if (g_tr_addr.length() < g_tr_limit)
        {
            g_tr_addr.insertLast(address);
            g_tr_size.insertLast(size);
            if (g_emu_bytes_on)
            {
                array<uint8> b;
                if (uc::mem_read(h, address, size, b)) g_tr_bytes.insertLast(emu_bytes_hex(b));
                else g_tr_bytes.insertLast("");
            }
        }
        else g_tr_dropped++;
    }

    g_run_count++;
    if (g_run_budget > 0 && g_run_count >= g_run_budget) return false; // instruction limit
    return true;
}

void emu_close_handle()
{
    if (g_emu != 0) { uc::close(g_emu); g_emu = 0; }
    g_emu_hook_installed = false;
    g_emu_status = "closed";
}

// Build the initial emulator state from the stored config: map stack, install the hook, apply the
// initial register values. `mode` selects create() vs create_process().
bool emu_build(const string &in id, int gen)
{
    emu_close_handle();
    g_emu = (g_emu_mode == "process") ? uc::create_process() : uc::create();
    if (g_emu == 0) return false;

    if (g_emu_stack_size > 0)
        uc::setup_stack(g_emu, g_emu_stack_base, g_emu_stack_size, g_emu_stop);

    if (uc::hook_code(g_emu, @on_emu_code)) g_emu_hook_installed = true;

    for (uint i = 0; i < g_emu_init_reg_names.length(); i++)
    {
        x86_reg r;
        if (emu_reg(g_emu_init_reg_names[i], r)) uc::reg_write64(g_emu, r, g_emu_init_reg_vals[i]);
    }
    // Seed rip so status/step start from the configured entry.
    uc::reg_write64(g_emu, x86_reg::rip, g_emu_entry);
    g_emu_rip = g_emu_entry;
    g_emu_session = id;
    g_emu_gen = gen;
    g_emu_status = "ready";
    return true;
}

void emu_send_error(const string &in id, int code, const string &in message)
{
    send_error(id, code, message);
}

// Reject an op whose session id or generation does not match the live session.
bool emu_session_ok(const string &in frame)
{
    if (g_emu == 0) return false;
    string sid = json_str(frame, "session", "");
    if (sid != g_emu_session) return false;
    if (json_has(frame, "generation") && int(json_num(frame, "generation", 0)) != g_emu_gen) return false;
    return true;
}

void handle_emu_create(const string &in frame, const string &in id)
{
    if (!ensure_attached()) { emu_send_error(id, 1001, "not attached"); return; }
    string sid = json_str(frame, "session", "");
    if (sid == "") { emu_send_error(id, 2001, "session id required"); return; }
    int gen = int(json_num(frame, "generation", 0));

    g_emu_mode = json_str(frame, "mode", "process");
    if (g_emu_mode != "process" && g_emu_mode != "standalone") g_emu_mode = "process";
    g_emu_entry = parse_u64_hex(json_str(frame, "entry", "0x0"));
    g_emu_stop = parse_u64_hex(json_str(frame, "stop", "0x0"));
    g_emu_stack_base = parse_u64_hex(json_str(frame, "stack_base", "0x0"));
    g_emu_stack_size = json_num(frame, "stack_size", EMU_STACK_SIZE_DEFAULT);
    if (g_emu_stack_size > EMU_STACK_SIZE_MAX) g_emu_stack_size = EMU_STACK_SIZE_MAX;
    g_emu_trace_on = json_num(frame, "trace", 1) != 0;
    g_emu_bytes_on = json_num(frame, "trace_bytes", 1) != 0;

    // Initial registers (flat CSV encodings so we avoid nested-JSON parsing).
    g_emu_init_reg_names = emu_split(json_str(frame, "reg_names", ""));
    array<string> rvals = emu_split(json_str(frame, "reg_values", ""));
    g_emu_init_reg_vals.resize(0);
    for (uint i = 0; i < g_emu_init_reg_names.length() && i < rvals.length(); i++)
        g_emu_init_reg_vals.insertLast(parse_u64_hex(rvals[i]));

    g_emu_breakpoints.resize(0);
    array<string> bps = emu_split(json_str(frame, "breakpoints", ""));
    for (uint i = 0; i < bps.length() && i < EMU_BREAKPOINT_MAX; i++)
        g_emu_breakpoints.insertLast(parse_u64_hex(bps[i]));

    g_emu_status = "creating";
    if (!emu_build(sid, gen)) { emu_send_error(id, 2002, "emulator creation failed"); return; }
    g_emu_insn_total = 0;

    ws::send("{\"type\":\"emulate_result\",\"id\":" + id +
             ",\"op\":\"create\",\"success\":true,\"session\":\"" + json_escape(sid) +
             "\",\"mode\":\"" + g_emu_mode + "\",\"status\":\"" + g_emu_status +
             "\",\"rip\":\"" + hex_addr(g_emu_rip) +
             "\",\"registers\":" + emu_registers_json() + "}");
}

void emu_send_status(const string &in id, const string &in op)
{
    ws::send("{\"type\":\"emulate_result\",\"id\":" + id +
             ",\"op\":\"" + op + "\",\"success\":true,\"session\":\"" + json_escape(g_emu_session) +
             "\",\"status\":\"" + g_emu_status +
             "\",\"rip\":\"" + hex_addr(g_emu_rip) +
             "\",\"instruction_total\":" + dec_u64(g_emu_insn_total) +
             ",\"registers\":" + emu_registers_json() + "}");
}

// Serialize the current run's trace as a bounded JSON array.
string emu_trace_json()
{
    string rows = "";
    for (uint i = 0; i < g_tr_addr.length(); i++)
    {
        if (i > 0) rows += ",";
        rows += "{\"index\":" + i + ",\"address\":\"" + hex_addr(g_tr_addr[i]) +
                "\",\"size\":" + g_tr_size[i];
        if (g_emu_bytes_on && i < g_tr_bytes.length())
            rows += ",\"bytes\":\"" + g_tr_bytes[i] + "\"";
        rows += "}";
    }
    return "[" + rows + "]";
}

// Map a uc::error code + run bookkeeping to a stop reason string.
string emu_stop_reason(int result, uint64 timeout_us, uint64 duration_us)
{
    if (g_hit_bp) return "breakpoint";
    if (result != uc::error::ok)
    {
        if (result == uc::error::read_unmapped) return "unmapped_read";
        if (result == uc::error::write_unmapped) return "unmapped_write";
        if (result == uc::error::fetch_unmapped) return "unmapped_fetch";
        if (result == uc::error::read_prot) return "protection_read";
        if (result == uc::error::write_prot) return "protection_write";
        if (result == uc::error::fetch_prot) return "protection_fetch";
        if (result == uc::error::insn_invalid) return "invalid_instruction";
        return "unicorn_error";
    }
    if (g_run_budget > 0 && g_run_count >= g_run_budget) return "instruction_limit";
    if (timeout_us > 0 && duration_us >= timeout_us) return "timeout";
    return "stop_reached";
}

void emu_run(const string &in frame, const string &in id, bool single_step)
{
    if (!emu_session_ok(frame)) { emu_send_error(id, 2003, "invalid or stale session"); return; }

    uint64 budget = single_step ? 1 : json_num(frame, "insn_budget", EMU_INSN_BUDGET_DEFAULT);
    if (budget == 0 || budget > EMU_INSN_BUDGET_MAX) budget = single_step ? 1 : EMU_INSN_BUDGET_MAX;
    uint64 timeout_us = single_step ? 0 : json_num(frame, "timeout_us", EMU_TIMEOUT_US_DEFAULT);
    if (timeout_us > EMU_TIMEOUT_US_MAX) timeout_us = EMU_TIMEOUT_US_MAX;
    g_tr_limit = uint(json_num(frame, "trace_limit", EMU_TRACE_LIMIT_DEFAULT));
    if (g_tr_limit > EMU_TRACE_LIMIT_MAX) g_tr_limit = EMU_TRACE_LIMIT_MAX;

    uint64 stop = json_has(frame, "stop") ? parse_u64_hex(json_str(frame, "stop", "0x0")) : g_emu_stop;

    // Reset per-run state.
    g_tr_addr.resize(0); g_tr_size.resize(0); g_tr_bytes.resize(0);
    g_tr_dropped = 0; g_run_count = 0; g_run_budget = budget; g_hit_bp = false; g_bp_addr = 0;

    uint64 begin = g_emu_rip;
    g_emu_status = "running";
    uint64 t0 = util::time_now();
    int result = uc::start(g_emu, begin, stop, timeout_us, budget);
    uint64 t1 = util::time_now();
    double dur_us = util::time_us(t0, t1);

    // Current rip after the run.
    uint64 rip_after = 0;
    uc::reg_read64(g_emu, x86_reg::rip, rip_after);
    g_emu_rip = rip_after;
    g_emu_insn_total += g_run_count;

    string reason = emu_stop_reason(result, timeout_us, uint64(dur_us));
    uint32 last_err = uc::last_error(g_emu);
    uint64 fault = uc::fault_address(g_emu);
    bool faulted = (result != uc::error::ok) && !g_hit_bp;
    g_emu_status = faulted ? "faulted" : (g_hit_bp || reason == "instruction_limit" || reason == "timeout") ? "paused" : "completed";

    ws::send("{\"type\":\"emulate_result\",\"id\":" + id +
             ",\"op\":\"" + (single_step ? "step" : "run") +
             "\",\"success\":true,\"session\":\"" + json_escape(g_emu_session) +
             "\",\"status\":\"" + g_emu_status +
             "\",\"stop_reason\":\"" + reason +
             "\",\"rip\":\"" + hex_addr(g_emu_rip) +
             "\",\"instruction_count\":" + dec_u64(g_run_count) +
             ",\"instruction_total\":" + dec_u64(g_emu_insn_total) +
             ",\"trace_count\":" + g_tr_addr.length() +
             ",\"trace_dropped\":" + g_tr_dropped +
             ",\"unicorn_error\":" + last_err +
             ",\"fault_address\":\"" + hex_addr(fault) +
             "\",\"duration_us\":" + dec_u64(uint64(dur_us)) +
             ",\"breakpoint\":\"" + hex_addr(g_bp_addr) +
             "\",\"registers\":" + emu_registers_json() +
             ",\"trace\":" + emu_trace_json() + "}");
}

void handle_emu_read_registers(const string &in frame, const string &in id)
{
    if (!emu_session_ok(frame)) { emu_send_error(id, 2003, "invalid or stale session"); return; }
    emu_send_status(id, "read_registers");
}

void handle_emu_write_register(const string &in frame, const string &in id)
{
    if (!emu_session_ok(frame)) { emu_send_error(id, 2003, "invalid or stale session"); return; }
    if (g_emu_status == "running") { emu_send_error(id, 2010, "cannot edit registers while running"); return; }
    string name = json_str(frame, "reg", "");
    x86_reg r;
    if (!emu_reg(name, r)) { emu_send_error(id, 2004, "unknown register: " + name); return; }
    uint64 v = parse_u64_hex(json_str(frame, "value", "0x0"));
    uc::reg_write64(g_emu, r, v);
    if (name == "rip") g_emu_rip = v;
    emu_send_status(id, "write_register");
}

void handle_emu_read_memory(const string &in frame, const string &in id)
{
    if (!emu_session_ok(frame)) { emu_send_error(id, 2003, "invalid or stale session"); return; }
    uint64 addr = parse_u64_hex(json_str(frame, "address", "0x0"));
    uint size = uint(json_num(frame, "size", 0));
    if (size == 0 || size > EMU_MEM_READ_MAX) { emu_send_error(id, 2005, "size out of range"); return; }
    array<uint8> b;
    bool ok = uc::mem_read(g_emu, addr, size, b);
    ws::send("{\"type\":\"emulate_result\",\"id\":" + id +
             ",\"op\":\"read_memory\",\"success\":" + bool_str(ok) +
             ",\"session\":\"" + json_escape(g_emu_session) +
             "\",\"address\":\"" + hex_addr(addr) +
             "\",\"data\":\"" + (ok ? emu_bytes_hex(b) : "") + "\"}");
}

void handle_emu_write_memory(const string &in frame, const string &in id)
{
    if (!emu_session_ok(frame)) { emu_send_error(id, 2003, "invalid or stale session"); return; }
    uint64 addr = parse_u64_hex(json_str(frame, "address", "0x0"));
    array<uint8> bytes = parse_hex_bytes(json_str(frame, "data", ""));
    if (bytes.length() == 0 || bytes.length() > EMU_MEM_WRITE_MAX) { emu_send_error(id, 2005, "size out of range"); return; }
    bool ok = uc::mem_write(g_emu, addr, bytes);
    // Emulator code may have changed — invalidate Unicorn's translation cache.
    if (ok) uc::flush_code(g_emu);
    ws::send("{\"type\":\"emulate_result\",\"id\":" + id +
             ",\"op\":\"write_memory\",\"success\":" + bool_str(ok) +
             ",\"session\":\"" + json_escape(g_emu_session) +
             "\",\"address\":\"" + hex_addr(addr) +
             "\",\"bytes_written\":" + (ok ? bytes.length() : uint(0)) + "}");
}

void handle_emu_reset(const string &in frame, const string &in id)
{
    if (!emu_session_ok(frame)) { emu_send_error(id, 2003, "invalid or stale session"); return; }
    // Rebuild the handle from stored config. For process-backed sessions this recreates the handle,
    // so demand-loaded pages may reflect NEWER target memory (documented — not a snapshot restore).
    g_emu_insn_total = 0;
    if (!emu_build(g_emu_session, g_emu_gen)) { emu_send_error(id, 2002, "emulator creation failed"); return; }
    emu_send_status(id, "reset");
}

void handle_emu_close(const string &in frame, const string &in id)
{
    string sid = json_str(frame, "session", "");
    if (g_emu != 0 && sid == g_emu_session) emu_close_handle();
    g_emu_session = "";
    g_emu_gen = -1;
    ws::send("{\"type\":\"emulate_result\",\"id\":" + id +
             ",\"op\":\"close\",\"success\":true,\"session\":\"" + json_escape(sid) +
             "\",\"status\":\"closed\"}");
}

void handle_emulate(const string &in frame, const string &in id)
{
    string op = json_str(frame, "op", "");
    if (op == "create") handle_emu_create(frame, id);
    else if (op == "status") { if (!emu_session_ok(frame)) { emu_send_error(id, 2003, "invalid or stale session"); return; } emu_send_status(id, "status"); }
    else if (op == "read_registers") handle_emu_read_registers(frame, id);
    else if (op == "write_register") handle_emu_write_register(frame, id);
    else if (op == "read_memory") handle_emu_read_memory(frame, id);
    else if (op == "write_memory") handle_emu_write_memory(frame, id);
    else if (op == "run") emu_run(frame, id, false);
    else if (op == "step") emu_run(frame, id, true);
    else if (op == "reset") handle_emu_reset(frame, id);
    else if (op == "close") handle_emu_close(frame, id);
    else emu_send_error(id, 2000, "unknown emulate op: " + op);
}

// --- capability handshake ----------------------------------------------------
// Report this agent's protocol version and the exact verb list it dispatches, so the frontend can
// negotiate capability availability from fact rather than assumption. Keep this list identical to
// the dispatch in on_ws_message (and to KNOWN_EXT_VERBS / EXT_VERBS on the TS side).
void handle_capabilities(const string &in frame, const string &in id)
{
    string verbs = "\"write\",\"dump\",\"exports\",\"imports\",\"iat_rebuild\",\"sections\"," +
                   "\"regions\",\"pe_header\",\"pe_dirs\",\"resource_tree\"," +
                   "\"scan_new\",\"scan_filter\",\"scan_clear\",\"scan_grouped\",\"raw_scan\"," +
                   "\"emulate\",\"capabilities\"";
    ws::send("{\"type\":\"capabilities_result\",\"id\":" + id +
             ",\"success\":true,\"protocol_version\":" + EXT_PROTOCOL_VERSION +
             ",\"verbs\":[" + verbs + "]}");
}

// --- ws:: plumbing ----------------------------------------------------------

void on_ws_open()
{
    ensure_attached();
    notify("relay connected (/agent-ext) - write/dump/exports/imports/scan ready", 80, 255, 120);
}

// Dispatch one request frame to its handler. This is where new /agent-ext verbs slot in.
void on_ws_message(const string &in msg)
{
    string type = json_str(msg, "type", "");
    string id = extract_id(msg);
    if (type == "write") handle_write(msg, id);
    else if (type == "dump") handle_dump(msg, id);
    else if (type == "exports") handle_exports(msg, id);
    else if (type == "imports") handle_imports(msg, id);
    else if (type == "iat_rebuild") handle_iat_rebuild(msg, id);
    else if (type == "sections") handle_sections(msg, id);
    else if (type == "regions") handle_regions(msg, id);
    else if (type == "pe_header") handle_pe_header(msg, id);
    else if (type == "pe_dirs") handle_pe_dirs(msg, id);
    else if (type == "resource_tree") handle_resource_tree(msg, id);
    else if (type == "scan_new") handle_scan_new(msg, id);
    else if (type == "scan_filter") handle_scan_filter(msg, id);
    else if (type == "scan_clear") handle_scan_clear(msg, id);
    else if (type == "scan_grouped") handle_scan_grouped(msg, id);
    else if (type == "raw_scan") handle_raw_scan(msg, id);
    else if (type == "emulate") handle_emulate(msg, id);
    else if (type == "capabilities") handle_capabilities(msg, id);
    else send_error(id, 1000, "unknown ext verb: " + type);
}

void on_ws_close()
{
    notify("relay disconnected - will retry", 255, 160, 40);
}

void on_ws_error(const string &in err)
{
    print("[web-mv ext] ws error: " + err);
}

void connect_relay()
{
    if (!ensure_attached())
    {
        notify("attach FAILED - is " + PROCESS_NAME + " running?", 255, 80, 80);
        return;
    }
    ws::connect(EXT_RELAY_URL, @on_ws_open, @on_ws_message, @on_ws_close, @on_ws_error);
}

void on_connect_click() { connect_relay(); }

void on_disconnect_click()
{
    emu_close_handle();
    g_emu_session = "";
    ws::disconnect();
    process::detach();
    g_attached = false;
    notify("disconnected", 200, 200, 200);
}

bool main()
{
    ui::add_tab("web-mv ext");
    ui::add_category("Ext agent");
    ui::add_button("Connect /agent-ext", @on_connect_click);
    ui::add_button("Disconnect", @on_disconnect_click);

    connect_relay();
    return true;
}

void on_unload()
{
    // Close any open Unicorn handle so no emulator state leaks on script unload.
    emu_close_handle();
    ws::disconnect();
    process::detach();
}
