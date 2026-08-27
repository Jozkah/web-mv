import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { CapabilitiesStore } from "./capabilitiesStore";
import { TimelineEventType, jsonDetails, type TimelineEventInput } from "../timeline/events";
import type { TimelineStore } from "../timeline/timelineStore";
import type { TsharkConfig } from "./tsharkConfig";
import {
    deriveConversations,
    deriveEndpoints,
    deriveMetadata,
    parseDissection,
    parseFollowStream,
    parsePacketSummaries,
    type CaptureMetadata,
    type Conversation,
    type Dissection,
    type Endpoint,
    type FollowStream,
    type PacketSummary,
} from "../network/pcapParse";
import { NETWORK_BUNDLE_SCHEMA_VERSION, sanitizeNetworkBundle, type NetworkCaptureBundle, type PacketReference } from "../network/networkBundle";

// Orchestrates the optional tshark adapter for OFFLINE PCAP analysis. It NEVER captures live packets
// and NEVER correlates packets to the attached Angel target (a pcap carries no PID/socket ownership).
// Transport is injected so the orchestration is testable without a tshark install.

export type TsharkSidecarState =
    | "unconfigured"
    | "pathValid"
    | "runnable"
    | "readyUnvalidated"
    | "liveValidated"
    | "failed"
    | "timedOut";

export interface TsharkProbeResult {
    ok: boolean;
    pathValid?: boolean;
    runnable?: boolean;
    version?: string;
    error?: string;
}
export interface TsharkAnalyzeResult {
    ok: boolean;
    op?: "summary" | "filter" | "dissect" | "follow";
    stdout?: string;
    truncated?: boolean;
    packetCap?: number;
    captureBytes?: number;
    captureHash?: string;
    format?: "pcap" | "pcapng";
    error?: string;
    durationMs?: number;
}
export interface TsharkJob {
    pcapFile: string;
    op: "summary" | "filter" | "dissect" | "follow";
    displayFilter?: string;
    frameNumber?: number;
    streamType?: "tcp" | "udp";
    streamIndex?: number;
}
export interface TsharkTransport {
    probe(config: TsharkConfig): Promise<TsharkProbeResult>;
    analyze(config: TsharkConfig, job: TsharkJob): Promise<TsharkAnalyzeResult>;
}

export interface NetworkDeps {
    config: Accessor<TsharkConfig>;
    capabilities: CapabilitiesStore;
    timeline: TimelineStore;
    setSidecar: (id: "tshark", present: boolean) => void;
    transport: TsharkTransport;
}

export function createNetworkStore(deps: NetworkDeps) {
    const [sidecarState, setSidecarState] = createSignal<TsharkSidecarState>("unconfigured");
    const [version, setVersion] = createSignal<string>();
    const [lastError, setLastError] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);

    const [activePcap, setActivePcap] = createSignal<string>();
    const [packets, setPackets] = createSignal<PacketSummary[]>([]);
    const [metadata, setMetadata] = createSignal<CaptureMetadata>();
    const [activeFilter, setActiveFilter] = createSignal<string>();
    const [follow, setFollow] = createSignal<FollowStream>();

    // Stable capture identity (from the relay, op "summary"). Annotations key packets by this hash.
    const [captureHash, setCaptureHash] = createSignal<string>();
    const [captureFormat, setCaptureFormat] = createSignal<"pcap" | "pcapng">();
    const [captureBytes, setCaptureBytes] = createSignal<number>();
    const [captureFilename, setCaptureFilename] = createSignal<string>();

    // An imported project bundle whose source PCAP is NOT present. Metadata + annotations show, but no
    // analysis runs until an explicit, hash-verified Relink.
    const [imported, setImported] = createSignal<NetworkCaptureBundle>();

    // Annotations / bookmarks / saved filters, keyed by captureHash so they survive a re-import or relink
    // and never depend on a filtered/visible row index.
    const bookmarks = new Map<string, Set<number>>(); // hash -> frame numbers
    const annotations = new Map<string, Map<number, string>>(); // hash -> frame -> note
    const captureNotes = new Map<string, string[]>(); // hash -> capture-level notes
    const savedFilters = new Map<string, string[]>(); // hash -> display filters
    const [annVersion, bumpAnn] = createSignal(0, { equals: false });

    const currentHash = () => captureHash() ?? imported()?.captureHash;

    const dissectCache = new Map<string, Dissection>(); // key: `${pcap}#${frame}`
    const [dissectVersion, bumpDissect] = createSignal(0, { equals: false });

    // Monotonic request token: an async result is discarded if a newer import/filter superseded it.
    let requestSeq = 0;
    // Separate token for follow-stream: a late follow result must not write the Follow pane after a
    // different capture was imported (which would attribute one capture's bytes to another).
    let followSeq = 0;

    const available = () => deps.capabilities.available("network.pcapImport");

    createEffect(
        on(deps.config, (cfg) => {
            if (!cfg.enabled || cfg.tsharkPath.trim() === "") {
                deps.setSidecar("tshark", false);
                setSidecarState("unconfigured");
                return;
            }
            setSidecarState("pathValid");
            deps.transport
                .probe(cfg)
                .then((r) => {
                    // The capability is available only after a bounded preflight (`runnable`), never from
                    // path existence alone.
                    deps.setSidecar("tshark", r.runnable === true);
                    setVersion(r.version);
                    setSidecarState((prev) => (prev === "liveValidated" ? prev : r.runnable ? "runnable" : "failed"));
                    if (!r.runnable) setLastError(r.error);
                })
                .catch((e) => {
                    deps.setSidecar("tshark", false);
                    setSidecarState("failed");
                    setLastError(e instanceof Error ? e.message : String(e));
                });
        }),
    );

    const emit = (input: TimelineEventInput) => deps.timeline.ingest(input);
    const evt = (type: string, severity: TimelineEventInput["severity"], summary: string, details?: Record<string, unknown>): TimelineEventInput => ({
        type,
        source: "network",
        severity,
        summary,
        provenance: "tshark offline PCAP analysis",
        confidence: "exact",
        tags: ["tshark", "pcap"],
        details: details ? jsonDetails(details) : undefined,
    });

    async function runSummary(pcapFile: string, displayFilter: string | undefined, op: "summary" | "filter"): Promise<{ ok: boolean; error?: string; count?: number }> {
        if (!available()) return { ok: false, error: "network.pcapImport is not available (configure a local tshark install)" };
        const seq = ++requestSeq;
        setLastError(undefined);
        setBusy(true);
        emit(evt(op === "summary" ? TimelineEventType.PcapImportStarted : TimelineEventType.PcapFilterApplied, "info", op === "summary" ? `PCAP: importing ${pcapFile}…` : `PCAP: filter "${displayFilter}"`, { pcapFile, displayFilter }));
        let res: TsharkAnalyzeResult;
        try {
            res = await deps.transport.analyze(deps.config(), { pcapFile, op, displayFilter });
        } catch (e) {
            return fail(pcapFile, e instanceof Error ? e.message : String(e));
        } finally {
            if (seq === requestSeq) setBusy(false);
        }
        if (seq !== requestSeq) {
            emit(evt(TimelineEventType.PcapImportCancelled, "notice", `PCAP: result discarded (superseded)`, { pcapFile }));
            return { ok: false, error: "superseded by a newer request" };
        }
        if (!res.ok || res.stdout === undefined) return fail(pcapFile, res.error ?? "tshark analysis failed");

        const pkts = parsePacketSummaries(res.stdout);
        const meta = deriveMetadata(pkts, res.truncated === true, res.captureBytes);
        setActivePcap(pcapFile);
        setActiveFilter(op === "filter" ? displayFilter : undefined);
        setPackets(pkts);
        setMetadata(meta);
        setFollow(undefined);
        // Identity is set only by import (summary carries the hash); a filter keeps the current identity.
        if (op === "summary") {
            if (res.captureHash) setCaptureHash(res.captureHash);
            setCaptureFormat(res.format);
            setCaptureBytes(res.captureBytes);
            setCaptureFilename(pcapFile);
        }
        dissectCache.clear();
        bumpDissect((n) => n + 1);
        setSidecarState("liveValidated");
        if (res.truncated) emit(evt(TimelineEventType.PcapTruncated, "warning", `PCAP: output truncated at the byte limit`, { pcapFile }));
        emit(evt(TimelineEventType.PcapImportCompleted, "info", `PCAP: ${pkts.length} packets from ${pcapFile}${meta.truncated ? " (truncated)" : ""}`, { pcapFile, packets: pkts.length, durationMs: res.durationMs }));
        return { ok: true, count: pkts.length };
    }

    function fail(pcapFile: string, message: string): { ok: false; error: string } {
        setLastError(message);
        if (/timed out|timeout/i.test(message)) setSidecarState("timedOut");
        emit(evt(TimelineEventType.PcapImportFailed, "warning", `PCAP failed for ${pcapFile}: ${message}`, { pcapFile, error: message }));
        return { ok: false, error: message };
    }

    async function importPcap(pcapFile: string) {
        return runSummary(pcapFile, undefined, "summary");
    }
    async function applyFilter(displayFilter: string) {
        const pcap = activePcap();
        if (!pcap) return { ok: false, error: "import a capture first" };
        return runSummary(pcap, displayFilter, "filter");
    }

    async function dissectPacket(frameNumber: number): Promise<{ ok: boolean; error?: string; cached?: boolean }> {
        if (!available()) return { ok: false, error: "network.pcapImport is not available" };
        const pcap = activePcap();
        if (!pcap) return { ok: false, error: "import a capture first" };
        const key = `${pcap}#${frameNumber}`;
        if (dissectCache.has(key)) {
            emit(evt(TimelineEventType.PcapCacheHit, "debug", `PCAP: dissection cache hit for frame ${frameNumber}`, { pcapFile: pcap, frameNumber }));
            return { ok: true, cached: true };
        }
        let res: TsharkAnalyzeResult;
        try {
            res = await deps.transport.analyze(deps.config(), { pcapFile: pcap, op: "dissect", frameNumber });
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!res.ok || res.stdout === undefined) return { ok: false, error: res.error ?? "dissection failed" };
        try {
            const d = parseDissection(res.stdout);
            dissectCache.set(key, d);
            bumpDissect((n) => n + 1);
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    function cachedDissection(frameNumber: number): Dissection | undefined {
        dissectVersion();
        const pcap = activePcap();
        return pcap ? dissectCache.get(`${pcap}#${frameNumber}`) : undefined;
    }

    async function followStream(streamType: "tcp" | "udp", streamIndex: number): Promise<{ ok: boolean; error?: string }> {
        if (!available()) return { ok: false, error: "network.pcapImport is not available" };
        const pcap = activePcap();
        if (!pcap) return { ok: false, error: "import a capture first" };
        const seq = ++followSeq;
        let res: TsharkAnalyzeResult;
        try {
            res = await deps.transport.analyze(deps.config(), { pcapFile: pcap, op: "follow", streamType, streamIndex });
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        // Discard if a newer follow was issued OR the active capture changed while this was in flight —
        // never write one capture's stream bytes into a pane now showing a different capture.
        if (seq !== followSeq || activePcap() !== pcap) return { ok: false, error: "superseded" };
        if (!res.ok || res.stdout === undefined) return { ok: false, error: res.error ?? "follow failed" };
        const stream = parseFollowStream(res.stdout);
        setFollow(stream);
        emit(evt(TimelineEventType.PcapStreamFollowed, "info", `PCAP: followed ${streamType} stream ${streamIndex} (${stream.totalBytes} bytes)`, { pcapFile: pcap, streamType, streamIndex, bytes: stream.totalBytes }));
        return { ok: true };
    }

    function resetState(): void {
        setActivePcap(undefined);
        setPackets([]);
        setMetadata(undefined);
        setActiveFilter(undefined);
        setFollow(undefined);
        setImported(undefined);
        setCaptureHash(undefined);
        setCaptureFormat(undefined);
        setCaptureBytes(undefined);
        setCaptureFilename(undefined);
        bookmarks.clear();
        annotations.clear();
        captureNotes.clear();
        savedFilters.clear();
        dissectCache.clear();
        bumpDissect((n) => n + 1);
        bumpAnn((n) => n + 1);
    }

    // --- annotations / bookmarks / saved filters (keyed by stable captureHash) ---
    function ensure<T>(m: Map<string, T>, key: string, mk: () => T): T {
        let v = m.get(key);
        if (v === undefined) { v = mk(); m.set(key, v); }
        return v;
    }
    function toggleBookmark(frame: number): void {
        const h = currentHash();
        if (!h) return;
        const set = ensure(bookmarks, h, () => new Set<number>());
        if (set.has(frame)) set.delete(frame); else set.add(frame);
        bumpAnn((n) => n + 1);
    }
    function isBookmarked(frame: number): boolean {
        annVersion();
        const h = currentHash();
        return h ? (bookmarks.get(h)?.has(frame) ?? false) : false;
    }
    function annotate(frame: number, note: string): void {
        const h = currentHash();
        if (!h) return;
        const m = ensure(annotations, h, () => new Map<number, string>());
        if (note.trim() === "") m.delete(frame); else m.set(frame, note.slice(0, 2000));
        bumpAnn((n) => n + 1);
    }
    function annotationOf(frame: number): string | undefined {
        annVersion();
        const h = currentHash();
        return h ? annotations.get(h)?.get(frame) : undefined;
    }
    function addCaptureNote(note: string): void {
        const h = currentHash();
        if (!h || note.trim() === "") return;
        ensure(captureNotes, h, () => []).push(note.slice(0, 2000));
        bumpAnn((n) => n + 1);
    }
    function saveFilter(f: string): void {
        const h = currentHash();
        if (!h || f.trim() === "") return;
        const list = ensure(savedFilters, h, () => []);
        if (!list.includes(f)) list.push(f);
        bumpAnn((n) => n + 1);
    }
    function savedFiltersList(): string[] {
        annVersion();
        const h = currentHash();
        return h ? [...(savedFilters.get(h) ?? [])] : [];
    }
    function bookmarkList(): number[] {
        annVersion();
        const h = currentHash();
        return h ? [...(bookmarks.get(h) ?? [])].sort((a, b) => a - b) : [];
    }

    // --- project bundle (inert export / import / relink) ---
    function exportBundle(): NetworkCaptureBundle[] {
        const h = currentHash();
        if (!h) return [];
        const meta = metadata();
        const imp = imported();
        // Prefer the live capture's derived data; fall back to the imported bundle's stored metadata.
        const pkts = packets();
        const refsFor = (frames: number[]): PacketReference[] => frames.map((frameNumber) => ({ captureHash: h, frameNumber }));
        const annList = [...(annotations.get(h) ?? new Map<number, string>()).entries()].map(([frameNumber, note]) => ({ ref: { captureHash: h, frameNumber }, note }));
        const bundle: NetworkCaptureBundle = sanitizeNetworkBundle({
            schemaVersion: NETWORK_BUNDLE_SCHEMA_VERSION,
            captureHash: h,
            filename: captureFilename() ?? imp?.filename,
            fileSize: captureBytes() ?? imp?.fileSize,
            format: captureFormat() ?? imp?.format,
            packetCount: meta?.packetCount ?? imp?.packetCount ?? 0,
            firstEpoch: meta?.firstEpoch ?? imp?.firstEpoch,
            lastEpoch: meta?.lastEpoch ?? imp?.lastEpoch,
            protocols: meta?.protocols ?? imp?.protocols ?? [],
            endpoints: pkts.length ? deriveEndpoints(pkts) : (imp?.endpoints ?? []),
            conversations: pkts.length ? deriveConversations(pkts) : (imp?.conversations ?? []),
            bookmarks: refsFor(bookmarkList()),
            packetAnnotations: annList,
            captureAnnotations: [...(captureNotes.get(h) ?? [])],
            savedFilters: savedFiltersList(),
            followRefs: [],
            truncated: meta?.truncated ?? imp?.truncated ?? false,
            tsharkProvenance: "tshark offline PCAP analysis",
            tsharkVersion: version(),
            sourceAvailable: !!activePcap(),
        });
        return [bundle];
    }

    // Load imported metadata INERT: no tshark call, no file access, source marked unavailable. Annotations
    // are re-keyed into the by-hash maps so a later Relink of the matching capture keeps them by frame.
    // One capture per bundle today (the project schema caps `network` at 1). We load exactly what we
    // accept and return that count — no silent drop, no count that overstates what was loaded.
    function importBundle(bundles: NetworkCaptureBundle[] | undefined): number {
        if (!bundles || bundles.length === 0) return 0;
        const b = sanitizeNetworkBundle(bundles[0]!);
        resetState();
        setImported(b);
        const h = b.captureHash;
        if (b.bookmarks.length) bookmarks.set(h, new Set(b.bookmarks.map((r) => r.frameNumber)));
        if (b.packetAnnotations.length) annotations.set(h, new Map(b.packetAnnotations.map((a) => [a.ref.frameNumber, a.note])));
        if (b.captureAnnotations.length) captureNotes.set(h, [...b.captureAnnotations]);
        if (b.savedFilters.length) savedFilters.set(h, [...b.savedFilters]);
        bumpAnn((n) => n + 1);
        return 1;
    }

    // Relink a local PCAP to imported metadata: runs the EXISTING explicit summary flow (containment,
    // size, magic all enforced relay-side), then verifies the returned content hash against the saved
    // one. A mismatch requires an explicit force; on adopt, annotations are re-keyed to the live hash so
    // they are preserved by frame identity.
    async function relinkCapture(pcapFile: string, opts?: { force?: boolean }): Promise<{ ok: boolean; error?: string; mismatch?: boolean }> {
        if (!available()) return { ok: false, error: "network.pcapImport is not available" };
        const imp = imported();
        if (!imp) return { ok: false, error: "no imported capture to relink" };
        let res: TsharkAnalyzeResult;
        try {
            res = await deps.transport.analyze(deps.config(), { pcapFile, op: "summary" });
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!res.ok || res.stdout === undefined) return { ok: false, error: res.error ?? "relink analysis failed" };
        const liveHash = res.captureHash;
        const matches = !!liveHash && liveHash === imp.captureHash;
        if (!matches && !opts?.force) {
            emit(evt(TimelineEventType.PcapImportFailed, "warning", `PCAP relink hash mismatch for ${pcapFile}`, { pcapFile, expected: imp.captureHash, got: liveHash }));
            return { ok: false, mismatch: true, error: "hash mismatch — the selected file is not the imported capture" };
        }
        // Adopt the live capture; re-key annotations from the imported hash to the (possibly new) live one.
        const oldHash = imp.captureHash;
        const newHash = liveHash ?? oldHash;
        if (newHash !== oldHash) {
            for (const map of [bookmarks, annotations, captureNotes, savedFilters] as Map<string, unknown>[]) {
                if (map.has(oldHash)) { map.set(newHash, map.get(oldHash)!); map.delete(oldHash); }
            }
        }
        const pkts = parsePacketSummaries(res.stdout);
        setImported(undefined);
        setActivePcap(pcapFile);
        setActiveFilter(undefined);
        setPackets(pkts);
        setMetadata(deriveMetadata(pkts, res.truncated === true, res.captureBytes));
        setCaptureHash(newHash);
        setCaptureFormat(res.format);
        setCaptureBytes(res.captureBytes);
        setCaptureFilename(pcapFile);
        setSidecarState("liveValidated");
        bumpAnn((n) => n + 1);
        emit(evt(TimelineEventType.PcapImportCompleted, "info", `PCAP relinked ${pcapFile} (${pkts.length} packets)${matches ? "" : " [forced, hash mismatch]"}`, { pcapFile, packets: pkts.length, matched: matches }));
        return { ok: true };
    }

    const endpoints = createMemo<Endpoint[]>(() => deriveEndpoints(packets()));
    const conversations = createMemo<Conversation[]>(() => deriveConversations(packets()));

    return {
        available,
        sidecarState,
        version,
        lastError,
        busy,
        activePcap,
        activeFilter,
        packets,
        metadata,
        endpoints,
        conversations,
        follow,
        importPcap,
        applyFilter,
        dissectPacket,
        cachedDissection,
        followStream,
        clearFilter: () => {
            const pcap = activePcap();
            if (pcap) return runSummary(pcap, undefined, "summary");
            return Promise.resolve({ ok: false, error: "no capture" });
        },
        // capture identity + inert project-bundle surface
        captureHash: currentHash,
        captureFormat,
        imported,
        toggleBookmark,
        isBookmarked,
        bookmarkList,
        annotate,
        annotationOf,
        addCaptureNote,
        saveFilter,
        savedFiltersList,
        exportBundle,
        importBundle,
        relinkCapture,
        reset: resetState,
    };
}

export type NetworkStore = ReturnType<typeof createNetworkStore>;
