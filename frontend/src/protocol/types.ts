import type { z } from "zod";
import type * as s from "./schemas";

// Request payloads (the fields beyond the {type, id} envelope, which AxClient adds).
// These mirror the `requests::*::parse` structs in ax_socket.cpp.
//
// Encoding rules from the C++:
//   - address fields accept a hex string OR a number; we always send hex strings.
//   - size fields MUST be JSON numbers (IsUint64), never strings.

/** Hex address string we send to the agent, e.g. "0x7ff6abcd1234". */
export type HexAddr = string;

export interface PingRequest {}

export interface ReadRequest {
    address: HexAddr;
    size: number; // 1..0x100000
}

export interface ReadBatchRequest {
    reads: Array<{ address: HexAddr; size: number }>; // per entry 1..0x10000
}

export interface ModulesRequest {}

export interface SigScanRequest {
    sig: string; // hex-encoded bytes
    mask: string; // length must equal decoded sig byte count
    module?: string;
    find_all?: boolean;
}

export interface SigScanIdaRequest {
    pattern: string; // IDA-style, e.g. "48 8B ?? ?? E8"
    module?: string;
    find_all?: boolean;
}

export interface StringScanRequest {
    text: string;
    module?: string;
    find_all?: boolean;
}

export interface ResolveRelativeRequest {
    address: HexAddr;
    offset?: number; // uint32
    inst_size?: number; // uint32
}

export interface RttiResolveRequest {
    address: HexAddr;
}

export interface RttiResolveBatchRequest {
    addresses: HexAddr[];
}

export interface EnumerateFunctionsRequest {
    module?: string;
}

export interface DisassembleRequest {
    address: HexAddr;
    size?: number;
}

// Response types are inferred from the Zod schemas so there is one source of truth.
export type ErrorResult = z.infer<typeof s.errorResult>;
export type PingResult = z.infer<typeof s.pingResult>;
export type ReadResult = z.infer<typeof s.readResult>;
export type ReadBatchResult = z.infer<typeof s.readBatchResult>;
export type ModulesResult = z.infer<typeof s.modulesResult>;
export type SigScanResult = z.infer<typeof s.sigScanResult>;
export type SigScanIdaResult = z.infer<typeof s.sigScanIdaResult>;
export type StringScanResult = z.infer<typeof s.stringScanResult>;
export type ResolveRelativeResult = z.infer<typeof s.resolveRelativeResult>;
export type RttiResolveResult = z.infer<typeof s.rttiResolveResult>;
export type RttiResolveBatchResult = z.infer<typeof s.rttiResolveBatchResult>;
export type EnumerateFunctionsResult = z.infer<typeof s.enumerateFunctionsResult>;
export type DisassembleResult = z.infer<typeof s.disassembleResult>;

// Element types of the array-bearing responses, for stores/components that work with
// a single row rather than the whole frame.
export type ModuleEntry = ModulesResult["modules"][number];
export type FunctionEntry = EnumerateFunctionsResult["results"][number];
export type Instruction = DisassembleResult["results"][number];
