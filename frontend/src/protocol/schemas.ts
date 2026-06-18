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
]);
