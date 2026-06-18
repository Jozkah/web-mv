import type { AxClient } from "../transport/AxClient";
import { RequestType } from "./messages";
import * as schemas from "./schemas";
import type * as t from "./types";

// Typed, per-message request wrappers - the seam between AxClient's generic
// request(type, payload, schema) primitive and the UI. Each wrapper binds the
// correct RequestType to its response schema so components never pair them by hand
// (and never call client.request raw). Add one function per protocol message.

export function ping(client: AxClient): Promise<t.PingResult> {
    return client.request(RequestType.Ping, {}, schemas.pingResult);
}

export function read(client: AxClient, req: t.ReadRequest): Promise<t.ReadResult> {
    return client.request(RequestType.Read, { ...req }, schemas.readResult);
}

export function readBatch(client: AxClient, req: t.ReadBatchRequest): Promise<t.ReadBatchResult> {
    return client.request(RequestType.ReadBatch, { ...req }, schemas.readBatchResult);
}

export function resolveRelative(
    client: AxClient,
    req: t.ResolveRelativeRequest,
): Promise<t.ResolveRelativeResult> {
    // Follow a RIP-relative reference: the agent reads the disp32 at `address + offset` and
    // returns `address + inst_size + disp32` (the target a mov/lea/call points at).
    return client.request(RequestType.ResolveRelative, { ...req }, schemas.resolveRelativeResult);
}

export function rttiResolve(client: AxClient, req: t.RttiResolveRequest): Promise<t.RttiResolveResult> {
    return client.request(RequestType.RttiResolve, { ...req }, schemas.rttiResolveResult);
}

// NOTE: batch results carry no echoed address - correlate to the request by array index.
export function rttiResolveBatch(
    client: AxClient,
    req: t.RttiResolveBatchRequest,
): Promise<t.RttiResolveBatchResult> {
    return client.request(RequestType.RttiResolveBatch, { ...req }, schemas.rttiResolveBatchResult);
}

export function sigScan(client: AxClient, req: t.SigScanRequest): Promise<t.SigScanResult> {
    // Empty results come back as success:false (not an error frame) - a normal "no match".
    return client.request(RequestType.SigScan, { ...req }, schemas.sigScanResult);
}

export function sigScanIda(client: AxClient, req: t.SigScanIdaRequest): Promise<t.SigScanIdaResult> {
    // The agent parses the IDA pattern string; we forward it verbatim.
    return client.request(RequestType.SigScanIda, { ...req }, schemas.sigScanIdaResult);
}

export function stringScan(client: AxClient, req: t.StringScanRequest): Promise<t.StringScanResult> {
    return client.request(RequestType.StringScan, { ...req }, schemas.stringScanResult);
}

export function modules(client: AxClient): Promise<t.ModulesResult> {
    return client.request(RequestType.Modules, {}, schemas.modulesResult);
}

export function enumerateFunctions(
    client: AxClient,
    req: t.EnumerateFunctionsRequest = {},
): Promise<t.EnumerateFunctionsResult> {
    // Omitted `module` makes the agent enumerate the main process base.
    return client.request(RequestType.EnumerateFunctions, { ...req }, schemas.enumerateFunctionsResult);
}

export function disassemble(
    client: AxClient,
    req: t.DisassembleRequest,
): Promise<t.DisassembleResult> {
    // We pass the function's known `size` (from its enumerate entry) so the agent
    // decodes exactly the function rather than a default-length window.
    return client.request(RequestType.Disassemble, { ...req }, schemas.disassembleResult);
}
