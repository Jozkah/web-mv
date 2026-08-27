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

// --- Extension agent (write-family) request payloads ------------------------

export interface WriteRequest {
    address: HexAddr;
    data: string; // hex-encoded little-endian bytes to write at address
}

export interface DumpRequest {
    module?: string; // omit to dump the main module
    path?: string; // output filename (sandboxed to the agent data dir); agent picks a default if omitted
}

export interface ExportsRequest {
    module?: string;
}

export interface ImportsRequest {
    module?: string;
}

export interface IatRebuildRequest {
    module?: string;
}

export interface SectionsRequest {
    module?: string;
}

export interface RegionsRequest {
    module?: string;
}

export type ScanValueType = "i32" | "u32" | "f32" | "i64" | "u64" | "unknown";
export type ScanFilterOp =
    | "unchanged"
    | "changed"
    | "increased"
    | "decreased"
    | "eq"
    | "gt"
    | "lt"
    | "approx"; // float-fuzzy: |current - value_hex(or previous)| <= epsilon_hex

export interface ScanNewRequest {
    module?: string;
    /** "module" (default) scans one module image; "process" sweeps committed heap/stack regions. */
    scope?: "module" | "process";
    /** "unknown" snapshots every aligned slot (no equality filter). */
    value_type: ScanValueType;
    /** Raw target bits as a hex number (e.g. int 100 → "0x64", float 12.5 → "0x41480000").
     *  Required unless value_type is "unknown". */
    value_hex?: string;
}

export interface ScanFilterRequest {
    op: ScanFilterOp;
    /** Raw comparison bits, required for eq/gt/lt/approx; omitted for the diff ops. */
    value_hex?: string;
    /** f32 bit pattern; only used by op "approx" (default 0.01). */
    epsilon_hex?: string;
}

export type ScanClearRequest = Record<string, never>;

export interface PeHeaderRequest {
    module?: string;
}

export interface PeDirsRequest {
    module?: string;
}

export interface ResourceTreeRequest {
    module?: string;
}

export interface ScanGroupedRequest {
    window?: number; // bytes each side of a hit, default 32, capped at 256
}

export type CapabilitiesRequest = Record<string, never>;

// Emulator: one `emulate` verb, op-dispatched. The payload beyond {op} varies by op; flat CSV
// encodings (reg_names/reg_values/breakpoints) avoid nested JSON in the AngelScript agent.
export interface EmulateRequest {
    op: "create" | "status" | "read_registers" | "write_register" | "read_memory" | "write_memory" | "run" | "step" | "reset" | "close";
    session: string;
    generation?: number;
    [key: string]: unknown;
}

export interface RawScanRequest {
    address: HexAddr;
    length: number;
    pattern: string; // IDA-style hex bytes, "?"/"??" wildcard, e.g. "48 8B ?? ?? E8"
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
export type WriteResult = z.infer<typeof s.writeResult>;
export type DumpResult = z.infer<typeof s.dumpResult>;
export type ExportsResult = z.infer<typeof s.exportsResult>;
export type ImportsResult = z.infer<typeof s.importsResult>;
export type IatRebuildResult = z.infer<typeof s.iatRebuildResult>;
export type SectionsResult = z.infer<typeof s.sectionsResult>;
export type RegionsResult = z.infer<typeof s.regionsResult>;
export type ScanNewResult = z.infer<typeof s.scanNewResult>;
export type ScanFilterResult = z.infer<typeof s.scanFilterResult>;
export type ScanClearResult = z.infer<typeof s.scanClearResult>;
export type ScanGroupedResult = z.infer<typeof s.scanGroupedResult>;
export type RawScanResult = z.infer<typeof s.rawScanResult>;
export type PeHeaderResult = z.infer<typeof s.peHeaderResult>;
export type PeDirsResult = z.infer<typeof s.peDirsResult>;
export type ResourceTreeResult = z.infer<typeof s.resourceTreeResult>;
export type CapabilitiesResult = z.infer<typeof s.capabilitiesResult>;
export type EmulateResult = z.infer<typeof s.emulateResult>;
export type EmuTraceEntry = NonNullable<EmulateResult["trace"]>[number];
export type PeDirEntry = PeDirsResult["results"][number];
export type ExportEntry = ExportsResult["results"][number];
export type ImportEntry = ImportsResult["results"][number];
export type IatRebuildEntry = IatRebuildResult["results"][number];
export type SectionEntry = SectionsResult["results"][number];
export type RegionEntry = RegionsResult["results"][number];
export type ScanHit = ScanNewResult["results"][number];
export type ScanGroupedHit = ScanGroupedResult["results"][number];

// Element types of the array-bearing responses, for stores/components that work with
// a single row rather than the whole frame.
export type ModuleEntry = ModulesResult["modules"][number];
export type FunctionEntry = EnumerateFunctionsResult["results"][number];
export type Instruction = DisassembleResult["results"][number];
