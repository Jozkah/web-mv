import { z } from "zod";
import { ResponseType } from "./messages";

// Zod schemas for every inbound frame. These are the single source of truth for
// response shapes - `types.ts` infers its response types from here. Field shapes
// mirror the `proto::`/`json::` encoders in ax_socket.cpp exactly.

// Addresses always arrive as lowercase, unpadded hex strings ("0x%llx").
const hexAddr = z.string().regex(/^0x[0-9a-f]+$/);

export const errorResult = z.object({
    type: z.literal(ResponseType.Error),
    id: z.number().int(),
    code: z.number().int(),
    message: z.string(),
    detail: z.string().optional(),
});

export const pingResult = z.object({
    type: z.literal(ResponseType.Ping),
    id: z.number().int(),
    attached: z.boolean(),
    pid: z.number().int().optional(),
    base: hexAddr.optional(),
});

export const readResult = z.object({
    type: z.literal(ResponseType.Read),
    id: z.number().int(),
    success: z.boolean(),
    address: hexAddr,
    size: z.number().int(),
    data: z.string(), // hex-encoded bytes
});

export const readBatchResult = z.object({
    type: z.literal(ResponseType.ReadBatch),
    id: z.number().int(),
    success: z.boolean(),
    results: z.array(
        z.object({
            success: z.boolean(),
            address: hexAddr,
            data: z.string(),
        }),
    ),
});

export const modulesResult = z.object({
    type: z.literal(ResponseType.Modules),
    id: z.number().int(),
    success: z.boolean(),
    modules: z.array(
        z.object({
            name: z.string(),
            base: hexAddr,
            size: z.number().int(),
        }),
    ),
});

// sig_scan / sig_scan_ida / string_scan share the scan-result core and add
// type-specific echo fields (see proto::make_scan_response).
const scanCore = {
    id: z.number().int(),
    success: z.boolean(),
    results: z.array(hexAddr),
    module: z.string(),
};

export const sigScanResult = z.object({
    type: z.literal(ResponseType.SigScan),
    ...scanCore,
    sig: z.string(),
    mask: z.string(),
});

export const sigScanIdaResult = z.object({
    type: z.literal(ResponseType.SigScanIda),
    ...scanCore,
    pattern: z.string(),
});

export const stringScanResult = z.object({
    type: z.literal(ResponseType.StringScan),
    ...scanCore,
    text: z.string(),
});

export const resolveRelativeResult = z.object({
    type: z.literal(ResponseType.ResolveRelative),
    id: z.number().int(),
    success: z.boolean(),
    address: hexAddr,
});

export const rttiResolveResult = z.object({
    type: z.literal(ResponseType.RttiResolve),
    id: z.number().int(),
    success: z.boolean(),
    address: hexAddr,
    name: z.string(),
});

// NOTE: batch entries have no echoed address - correlate to the request by index.
export const rttiResolveBatchResult = z.object({
    type: z.literal(ResponseType.RttiResolveBatch),
    id: z.number().int(),
    success: z.boolean(),
    results: z.array(
        z.object({
            success: z.boolean(),
            name: z.string(),
        }),
    ),
});

export const enumerateFunctionsResult = z.object({
    type: z.literal(ResponseType.EnumerateFunctions),
    id: z.number().int(),
    success: z.boolean(),
    module: z.string(),
    count: z.number().int(),
    results: z.array(
        z.object({
            address: hexAddr,
            size: z.number().int(),
            method: z.number().int(),
        }),
    ),
});

export const disassembleResult = z.object({
    type: z.literal(ResponseType.Disassemble),
    id: z.number().int(),
    success: z.boolean(),
    complete: z.boolean(),
    address: hexAddr,
    count: z.number().int(),
    results: z.array(
        z.object({
            address: hexAddr,
            length: z.number().int(),
            bytes: z.string(),
            text: z.string(),
        }),
    ),
});

// --- Extension agent (write-family) responses ------------------------------

export const writeResult = z.object({
    type: z.literal(ResponseType.Write),
    id: z.number().int(),
    success: z.boolean(),
    address: hexAddr,
    bytes_written: z.number().int(),
});

export const dumpResult = z.object({
    type: z.literal(ResponseType.Dump),
    id: z.number().int(),
    success: z.boolean(),
    path: z.string(),
});

// exports / imports share the PE-symbol row shape.
const peSymbolCore = {
    id: z.number().int(),
    success: z.boolean(),
    module: z.string(),
    count: z.number().int(),
};

export const exportsResult = z.object({
    type: z.literal(ResponseType.Exports),
    ...peSymbolCore,
    results: z.array(
        z.object({
            name: z.string(),
            address: hexAddr,
            ordinal: z.number().int(),
        }),
    ),
});

export const importsResult = z.object({
    type: z.literal(ResponseType.Imports),
    ...peSymbolCore,
    results: z.array(
        z.object({
            module: z.string(), // source DLL the symbol is imported from
            name: z.string(),
            iat: hexAddr, // address of the IAT slot
        }),
    ),
});

export const sectionsResult = z.object({
    type: z.literal(ResponseType.Sections),
    id: z.number().int(),
    success: z.boolean(),
    module: z.string(),
    count: z.number().int(),
    results: z.array(
        z.object({
            name: z.string(),
            address: hexAddr, // base + VirtualAddress
            size: z.number().int(), // VirtualSize
            raw_size: z.number().int(), // SizeOfRawData
            characteristics: z.number().int(), // IMAGE_SCN_* flags
            protect: z.string(), // short r/w/x string derived from characteristics
        }),
    ),
});

export const regionsResult = z.object({
    type: z.literal(ResponseType.Regions),
    id: z.number().int(),
    success: z.boolean(),
    module: z.string(),
    count: z.number().int(),
    results: z.array(
        z.object({
            base: hexAddr,
            size: z.number().int(), // region byte length
            protect: z.number().int(), // Windows PAGE_* constant
            state: z.number().int(), // MEM_COMMIT / MEM_RESERVE
            type: z.number().int(), // MEM_IMAGE / MEM_MAPPED / MEM_PRIVATE
            prot: z.string(), // short r/w/x(g) string derived from `protect`
        }),
    ),
});

// Value-scanner frames. First scan (scan_new) and each filter pass (scan_filter) return the
// surviving candidate count plus a bounded sample of {address, value}; scan_clear resets it.
const scanResult = (type: string) =>
    z.object({
        type: z.literal(type),
        id: z.number().int(),
        success: z.boolean(),
        value_type: z.string().optional(),
        count: z.number().int(),
        results: z.array(z.object({ address: hexAddr, value: z.number() })),
    });
export const scanNewResult = scanResult(ResponseType.ScanNew);
export const scanFilterResult = scanResult(ResponseType.ScanFilter);
export const scanClearResult = scanResult(ResponseType.ScanClear);

export const peHeaderResult = z.object({
    type: z.literal(ResponseType.PeHeader),
    id: z.number().int(),
    success: z.boolean(),
    module: z.string(),
    machine: z.number().int(),
    magic: z.number().int(),
    num_sections: z.number().int(),
    timestamp: z.number().int(),
    characteristics: z.number().int(),
    subsystem: z.number().int(),
    dll_characteristics: z.number().int(),
    checksum: z.number().int(),
    size_of_image: z.number().int(),
    entry_point: hexAddr,
    image_base: hexAddr,
});

export const peDirsResult = z.object({
    type: z.literal(ResponseType.PeDirs),
    id: z.number().int(),
    success: z.boolean(),
    module: z.string(),
    count: z.number().int(),
    results: z.array(
        z.object({
            name: z.string(),
            rva: hexAddr,
            address: hexAddr,
            size: z.number().int(),
        }),
    ),
});

// --- Extension agent: additional verbs (iat rebuild, resource tree, grouped/raw scans) ---

// IAT rebuild: resolve each import thunk back to its {module, name/ordinal} plus the RVAs
// needed to rebuild an import table for a dumped image.
export const iatRebuildResult = z.object({
    type: z.literal(ResponseType.IatRebuild),
    id: z.number().int(),
    success: z.boolean(),
    module: z.string(),
    count: z.number().int(),
    results: z.array(
        z.object({
            module: z.string(),
            name: z.string(),
            by_ordinal: z.boolean(),
            ordinal: z.number().int(),
            iat: hexAddr,
            iat_rva: hexAddr,
            thunk_rva: hexAddr,
            resolved: hexAddr,
        }),
    ),
});

// Resource directory tree - recursive, so the node type is declared explicitly and the Zod
// schema is z.lazy over it.
export interface ResourceTreeNode {
    level: number;
    named: boolean;
    id: number;
    name: string;
    is_dir: boolean;
    children?: ResourceTreeNode[];
    address?: string;
    size?: number;
    code_page?: number;
}

const resourceTreeNode: z.ZodType<ResourceTreeNode> = z.lazy(() =>
    z.object({
        level: z.number().int(),
        named: z.boolean(),
        id: z.number().int(),
        name: z.string(),
        is_dir: z.boolean(),
        children: z.array(resourceTreeNode).optional(),
        address: hexAddr.optional(),
        size: z.number().int().optional(),
        code_page: z.number().int().optional(),
    }),
);

export const resourceTreeResult = z.object({
    type: z.literal(ResponseType.ResourceTree),
    id: z.number().int(),
    success: z.boolean(),
    module: z.string(),
    count: z.number().int(),
    results: z.array(resourceTreeNode),
});

// Grouped scan: cluster surviving hits and expose the u32 slots around each, for spotting
// nearby fields (e.g. a struct that holds the value being scanned for).
export const scanGroupedResult = z.object({
    type: z.literal(ResponseType.ScanGrouped),
    id: z.number().int(),
    success: z.boolean(),
    count: z.number().int(),
    results: z.array(
        z.object({
            hit: hexAddr,
            slots: z.array(
                z.object({
                    offset: z.number().int(),
                    address: hexAddr,
                    value_u32: z.number().int(),
                }),
            ),
        }),
    ),
});

// Raw byte-pattern scan over an explicit address range (IDA-style pattern with wildcards).
export const rawScanResult = z.object({
    type: z.literal(ResponseType.RawScan),
    id: z.number().int(),
    success: z.boolean(),
    address: hexAddr,
    length: z.string(), // decimal string — can exceed 2^53
    count: z.number().int(),
    results: z.array(hexAddr),
});

// Discriminated union of every non-error response, for callers that want to parse
// a frame without knowing its type up front. AxClient validates against the specific
// per-request schema instead, but this is here for completeness/tooling.
export const responseSchema = z.discriminatedUnion("type", [
    pingResult,
    readResult,
    readBatchResult,
    modulesResult,
    sigScanResult,
    sigScanIdaResult,
    stringScanResult,
    resolveRelativeResult,
    rttiResolveResult,
    rttiResolveBatchResult,
    enumerateFunctionsResult,
    disassembleResult,
    writeResult,
    dumpResult,
    exportsResult,
    importsResult,
    iatRebuildResult,
    sectionsResult,
    regionsResult,
    scanNewResult,
    scanFilterResult,
    scanClearResult,
    scanGroupedResult,
    rawScanResult,
    peHeaderResult,
    peDirsResult,
    resourceTreeResult,
]);
