import type { AxClient } from "../transport/AxClient";
import { RequestType } from "./messages";
import * as schemas from "./schemas";
import type * as t from "./types";

// Typed, per-message request wrappers - the seam between AxClient's generic
// request(type, payload, schema) primitive and the UI. Each wrapper binds the
// correct RequestType to its response schema so components never pair them by hand
// (and never call client.request raw). Add one function per protocol message.

// Whole-module operations (enumerate, signature/string scans) can run for minutes on large
// binaries, well past AxClient's default per-request timeout. Give them a generous ceiling so
// the web side doesn't give up while the agent is still working.
const SLOW_TIMEOUT_MS = 5 * 60_000;

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
    return client.request(RequestType.SigScan, { ...req }, schemas.sigScanResult, SLOW_TIMEOUT_MS);
}

export function sigScanIda(client: AxClient, req: t.SigScanIdaRequest): Promise<t.SigScanIdaResult> {
    // The agent parses the IDA pattern string; we forward it verbatim.
    return client.request(RequestType.SigScanIda, { ...req }, schemas.sigScanIdaResult, SLOW_TIMEOUT_MS);
}

export function stringScan(client: AxClient, req: t.StringScanRequest): Promise<t.StringScanResult> {
    return client.request(RequestType.StringScan, { ...req }, schemas.stringScanResult, SLOW_TIMEOUT_MS);
}

export function modules(client: AxClient): Promise<t.ModulesResult> {
    return client.request(RequestType.Modules, {}, schemas.modulesResult);
}

export function enumerateFunctions(
    client: AxClient,
    req: t.EnumerateFunctionsRequest = {},
): Promise<t.EnumerateFunctionsResult> {
    // Omitted `module` makes the agent enumerate the main process base.
    return client.request(RequestType.EnumerateFunctions, { ...req }, schemas.enumerateFunctionsResult, SLOW_TIMEOUT_MS);
}

export function disassemble(
    client: AxClient,
    req: t.DisassembleRequest,
): Promise<t.DisassembleResult> {
    // We pass the function's known `size` (from its enumerate entry) so the agent
    // decodes exactly the function rather than a default-length window.
    return client.request(RequestType.Disassemble, { ...req }, schemas.disassembleResult);
}

// --- Extension agent (write-family). Routed to /agent-ext by the relay. ------
// Same AxClient / relay socket as everything above — the split is transparent to callers.

export function write(client: AxClient, req: t.WriteRequest): Promise<t.WriteResult> {
    return client.request(RequestType.Write, { ...req }, schemas.writeResult);
}

export function dump(client: AxClient, req: t.DumpRequest = {}): Promise<t.DumpResult> {
    // A full-module dump walks the whole mapped image; give it the slow ceiling.
    return client.request(RequestType.Dump, { ...req }, schemas.dumpResult, SLOW_TIMEOUT_MS);
}

export function exports(client: AxClient, req: t.ExportsRequest = {}): Promise<t.ExportsResult> {
    return client.request(RequestType.Exports, { ...req }, schemas.exportsResult, SLOW_TIMEOUT_MS);
}

export function imports(client: AxClient, req: t.ImportsRequest = {}): Promise<t.ImportsResult> {
    return client.request(RequestType.Imports, { ...req }, schemas.importsResult, SLOW_TIMEOUT_MS);
}

export function iatRebuild(client: AxClient, req: t.IatRebuildRequest = {}): Promise<t.IatRebuildResult> {
    return client.request(RequestType.IatRebuild, { ...req }, schemas.iatRebuildResult, SLOW_TIMEOUT_MS);
}

export function sections(client: AxClient, req: t.SectionsRequest = {}): Promise<t.SectionsResult> {
    return client.request(RequestType.Sections, { ...req }, schemas.sectionsResult);
}

export function regions(client: AxClient, req: t.RegionsRequest = {}): Promise<t.RegionsResult> {
    return client.request(RequestType.Regions, { ...req }, schemas.regionsResult, SLOW_TIMEOUT_MS);
}

export function scanNew(client: AxClient, req: t.ScanNewRequest): Promise<t.ScanNewResult> {
    return client.request(RequestType.ScanNew, { ...req }, schemas.scanNewResult, SLOW_TIMEOUT_MS);
}

export function scanFilter(client: AxClient, req: t.ScanFilterRequest): Promise<t.ScanFilterResult> {
    return client.request(RequestType.ScanFilter, { ...req }, schemas.scanFilterResult, SLOW_TIMEOUT_MS);
}

export function scanClear(client: AxClient): Promise<t.ScanClearResult> {
    return client.request(RequestType.ScanClear, {}, schemas.scanClearResult);
}

export function peHeader(client: AxClient, req: t.PeHeaderRequest = {}): Promise<t.PeHeaderResult> {
    return client.request(RequestType.PeHeader, { ...req }, schemas.peHeaderResult);
}

export function peDirs(client: AxClient, req: t.PeDirsRequest = {}): Promise<t.PeDirsResult> {
    return client.request(RequestType.PeDirs, { ...req }, schemas.peDirsResult);
}

export function resourceTree(
    client: AxClient,
    req: t.ResourceTreeRequest = {},
): Promise<t.ResourceTreeResult> {
    return client.request(RequestType.ResourceTree, { ...req }, schemas.resourceTreeResult, SLOW_TIMEOUT_MS);
}

export function scanGrouped(
    client: AxClient,
    req: t.ScanGroupedRequest = {},
): Promise<t.ScanGroupedResult> {
    return client.request(RequestType.ScanGrouped, { ...req }, schemas.scanGroupedResult);
}

export function rawScan(client: AxClient, req: t.RawScanRequest): Promise<t.RawScanResult> {
    return client.request(RequestType.RawScan, { ...req }, schemas.rawScanResult, SLOW_TIMEOUT_MS);
}
