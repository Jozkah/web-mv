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
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
