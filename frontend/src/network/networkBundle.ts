import { z } from "zod";

// INERT, bounded Network Workbench metadata for the project bundle. This persists only derived analysis
// metadata + user annotations — NEVER raw packet bytes, full followed streams, absolute paths, live
// jobs, PIDs, or sidecar config. Importing it starts nothing: it shows metadata + annotations, marks the
// source PCAP unavailable, and requires an explicit, hash-verified Relink before any tshark runs.
//
// Stable identity: a capture is keyed by its CONTENT HASH, and every annotation/bookmark keys the packet
// by (captureHash, frameNumber) — never by a filtered/visible row index.

export const NETWORK_BUNDLE_SCHEMA_VERSION = 1 as const;

// Bounds (a malicious/oversized bundle can never blow these up on import).
export const NET_LIMITS = {
    endpoints: 2000,
    conversations: 2000,
    bookmarks: 1000,
    annotations: 2000,
    captureAnnotations: 200,
    savedFilters: 100,
    followRefs: 200,
    protocols: 200,
    noteLen: 2000,
    filterLen: 512,
} as const;

const boundedNote = z.string().max(NET_LIMITS.noteLen);

export const packetReferenceSchema = z.object({
    captureHash: z.string().min(1).max(128),
    frameNumber: z.number().int().nonnegative(),
    timestamp: z.string().max(64).optional(),
});
export type PacketReference = z.infer<typeof packetReferenceSchema>;

export const endpointRefSchema = z.object({ address: z.string().max(128), packets: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() });
export const conversationRefSchema = z.object({
    a: z.string().max(128),
    b: z.string().max(128),
    protocol: z.string().max(32),
    stream: z.number().int().nonnegative().optional(),
    packets: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
});
export const followRefSchema = z.object({ streamType: z.enum(["tcp", "udp"]), streamIndex: z.number().int().nonnegative(), note: boundedNote.optional() });
export const packetAnnotationSchema = z.object({ ref: packetReferenceSchema, note: boundedNote });

export const networkCaptureBundleSchema = z.object({
    schemaVersion: z.literal(NETWORK_BUNDLE_SCHEMA_VERSION),
    captureHash: z.string().min(1).max(128),
    filename: z.string().max(260).optional(), // basename only — no path authority
    fileSize: z.number().int().nonnegative().optional(),
    format: z.enum(["pcap", "pcapng"]).optional(),
    linkLayer: z.string().max(64).optional(),
    packetCount: z.number().int().nonnegative(),
    firstEpoch: z.number().optional(),
    lastEpoch: z.number().optional(),
    protocols: z.array(z.string().max(64)).max(NET_LIMITS.protocols).default([]),
    endpoints: z.array(endpointRefSchema).max(NET_LIMITS.endpoints).default([]),
    conversations: z.array(conversationRefSchema).max(NET_LIMITS.conversations).default([]),
    bookmarks: z.array(packetReferenceSchema).max(NET_LIMITS.bookmarks).default([]),
    packetAnnotations: z.array(packetAnnotationSchema).max(NET_LIMITS.annotations).default([]),
    captureAnnotations: z.array(boundedNote).max(NET_LIMITS.captureAnnotations).default([]),
    savedFilters: z.array(z.string().max(NET_LIMITS.filterLen)).max(NET_LIMITS.savedFilters).default([]),
    selectedRef: packetReferenceSchema.optional(),
    followRefs: z.array(followRefSchema).max(NET_LIMITS.followRefs).default([]),
    truncated: z.boolean().default(false),
    tsharkProvenance: z.string().max(128).optional(),
    tsharkVersion: z.string().max(64).optional(),
    // Whether the source PCAP was still present when this was saved. Import always treats it as absent
    // until an explicit hash-verified relink; this is advisory only.
    sourceAvailable: z.boolean().default(false),
    cacheRef: z.string().max(128).optional(), // controlled internal id, never a path
});
export type NetworkCaptureBundle = z.infer<typeof networkCaptureBundleSchema>;

// Deterministically clamp + dedup a bundle being BUILT from live state (belt-and-suspenders; the schema
// also enforces the caps on import). Dedup packet refs by frameNumber (annotations keep the last note),
// keeping ascending frame order so output is stable.
export function sanitizeNetworkBundle(b: NetworkCaptureBundle): NetworkCaptureBundle {
    const dedupRefs = (refs: PacketReference[]): PacketReference[] => {
        const m = new Map<number, PacketReference>();
        for (const r of refs) if (!m.has(r.frameNumber)) m.set(r.frameNumber, r);
        return [...m.values()].sort((x, y) => x.frameNumber - y.frameNumber);
    };
    const dedupAnnotations = (as: { ref: PacketReference; note: string }[]) => {
        const m = new Map<number, { ref: PacketReference; note: string }>();
        for (const a of as) m.set(a.ref.frameNumber, a); // last note wins
        return [...m.values()].sort((x, y) => x.ref.frameNumber - y.ref.frameNumber);
    };
    return {
        ...b,
        protocols: b.protocols.slice(0, NET_LIMITS.protocols),
        endpoints: b.endpoints.slice(0, NET_LIMITS.endpoints),
        conversations: b.conversations.slice(0, NET_LIMITS.conversations),
        bookmarks: dedupRefs(b.bookmarks).slice(0, NET_LIMITS.bookmarks),
        packetAnnotations: dedupAnnotations(b.packetAnnotations).slice(0, NET_LIMITS.annotations),
        captureAnnotations: b.captureAnnotations.slice(0, NET_LIMITS.captureAnnotations),
        savedFilters: [...new Set(b.savedFilters)].slice(0, NET_LIMITS.savedFilters),
        followRefs: b.followRefs.slice(0, NET_LIMITS.followRefs),
    };
}

export function parseNetworkBundles(value: unknown): NetworkCaptureBundle[] {
    const arr = z.array(networkCaptureBundleSchema).parse(value);
    return arr.map(sanitizeNetworkBundle);
}
