// Protocol vocabulary. String and error-code constants, mirrored from the C++
// `dispatch::routes`, response `type` strings, and `proto::error_code`. No I/O here.

export const RequestType = {
    Ping: "ping",
    Read: "read",
    ReadBatch: "read_batch",
    Modules: "modules",
    SigScan: "sig_scan",
    SigScanIda: "sig_scan_ida",
    StringScan: "string_scan",
    ResolveRelative: "resolve_relative",
    RttiResolve: "rtti_resolve",
    RttiResolveBatch: "rtti_resolve_batch",
    EnumerateFunctions: "enumerate_functions",
    Disassemble: "disassemble",
    // Extension agent (write-family). Served by the ext AngelScript agent on /agent-ext.
    Write: "write",
    Dump: "dump",
    Exports: "exports",
    Imports: "imports",
    IatRebuild: "iat_rebuild",
    Sections: "sections",
    Regions: "regions",
    ScanNew: "scan_new",
    ScanFilter: "scan_filter",
    ScanClear: "scan_clear",
    ScanGrouped: "scan_grouped",
    RawScan: "raw_scan",
    PeHeader: "pe_header",
    PeDirs: "pe_dirs",
    ResourceTree: "resource_tree",
    // Unicorn emulator verb family (op-dispatched). Served by the ext agent, routed to /agent-ext.
    Emulate: "emulate",
    // Capability handshake. Served by the ext agent (it is the source of truth for which
    // write-family verbs it implements). Routed to /agent-ext by the relay.
    Capabilities: "capabilities",
    // Menu control: enumerate/get/set the ext agent's own overlay controls. Served by the ext agent.
    UiList: "ui_list",
    UiGet: "ui_get",
    UiSet: "ui_set",
} as const;
export type RequestType = (typeof RequestType)[keyof typeof RequestType];

export const ResponseType = {
    Ping: "ping_result",
    Read: "read_result",
    ReadBatch: "read_batch_result",
    Modules: "modules_result",
    SigScan: "sig_scan_result",
    SigScanIda: "sig_scan_ida_result",
    StringScan: "string_scan_result",
    ResolveRelative: "resolve_relative_result",
    RttiResolve: "rtti_resolve_result",
    RttiResolveBatch: "rtti_resolve_batch_result",
    EnumerateFunctions: "enumerate_functions_result",
    Disassemble: "disassemble_result",
    Write: "write_result",
    Dump: "dump_result",
    Exports: "exports_result",
    Imports: "imports_result",
    IatRebuild: "iat_rebuild_result",
    Sections: "sections_result",
    Regions: "regions_result",
    ScanNew: "scan_new_result",
    ScanFilter: "scan_filter_result",
    ScanClear: "scan_clear_result",
    ScanGrouped: "scan_grouped_result",
    RawScan: "raw_scan_result",
    PeHeader: "pe_header_result",
    PeDirs: "pe_dirs_result",
    ResourceTree: "resource_tree_result",
    Emulate: "emulate_result",
    Capabilities: "capabilities_result",
    UiList: "ui_list_result",
    UiGet: "ui_get_result",
    UiSet: "ui_set_result",
    Error: "error",
} as const;
export type ResponseType = (typeof ResponseType)[keyof typeof ResponseType];

// Mirror of ax_analysis::find_method - how a function entry was discovered, sent as
// the integer `method` field on each enumerate_functions result row.
export const FindMethod = {
    ExceptionDirectory: 0,
    PrologueScan: 1,
} as const;
export type FindMethod = (typeof FindMethod)[keyof typeof FindMethod];

const findMethodLabels: Record<number, string> = {
    [FindMethod.ExceptionDirectory]: "exception dir",
    [FindMethod.PrologueScan]: "prologue scan",
};

export function findMethodLabel(method: number): string {
    return findMethodLabels[method] ?? `method ${method}`;
}

// Mirror of proto::error_code in ax_socket.cpp.
export const ErrorCode = {
    Success: 0,
    UnknownType: 1000,
    NotAttached: 1001,
    InvalidArgs: 1002,
    ModuleNotFound: 1003,
    SizeOutOfRange: 1004,
    ReadFailed: 1005,
    EnumerateFailed: 1006,
    DisassembleFailed: 1007,
    WriteFailed: 1008,
    DumpFailed: 1009,
    ExportsFailed: 1010,
    // --- /agent-ext codes (web_mv_ext_agent.as) ---
    NoDataDirectory: 1011,
    UnsupportedValueType: 1020,
    ModuleSizeUnavailable: 1021,
    NoActiveScan: 1022,
    InvalidPattern: 1023,
    // Menu control: a danger-flagged control was set while the operator has not clicked ARM.
    MenuControlDisarmed: 1024,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
