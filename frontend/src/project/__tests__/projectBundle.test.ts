import { describe, expect, it } from "vitest";
import { buildBundle, compareBundles, parseBundle, PROJECT_SCHEMA_VERSION, type ProjectBundle } from "../projectBundle";
import { NETWORK_BUNDLE_SCHEMA_VERSION, sanitizeNetworkBundle, type NetworkCaptureBundle } from "../../network/networkBundle";

const netBundle = (over: Partial<NetworkCaptureBundle> = {}): NetworkCaptureBundle =>
    sanitizeNetworkBundle({
        schemaVersion: NETWORK_BUNDLE_SCHEMA_VERSION,
        captureHash: "abc123",
        packetCount: 3,
        protocols: ["TCP"],
        endpoints: [],
        conversations: [],
        bookmarks: [{ captureHash: "abc123", frameNumber: 2 }],
        packetAnnotations: [{ ref: { captureHash: "abc123", frameNumber: 2 }, note: "handshake" }],
        captureAnnotations: [],
        savedFilters: ["tcp.port==443"],
        followRefs: [],
        truncated: false,
        sourceAvailable: false,
        ...over,
    } as NetworkCaptureBundle);

const bundle = (over: Partial<Parameters<typeof buildBundle>[0]> = {}): ProjectBundle =>
    buildBundle({
        createdAt: "2026-01-01T00:00:00.000Z",
        target: { key: "pid:1", pid: 1, name: "game.exe" },
        patches: [{ id: "p1", module: "game.exe", rva: "0x10", patchedBytes: "9090" }],
        watches: [{ id: "w1", expression: "game.exe+0x20" }],
        ...over,
    });

describe("project bundle", () => {
    it("round-trips through parse", () => {
        const b = bundle();
        const parsed = parseBundle(JSON.stringify(b));
        expect(parsed.target.key).toBe("pid:1");
        expect(parsed.patches?.length).toBe(1);
    });

    it("rejects a bad schema / non-JSON", () => {
        expect(() => parseBundle("{not json")).toThrow();
        expect(() => parseBundle(JSON.stringify({ format: "wrong", schemaVersion: 1, createdAt: "t", target: { key: "x" } }))).toThrow();
    });

    it("compares target identity and diffs patch/watch sets", () => {
        const a = bundle();
        const b = bundle({
            target: { key: "pid:2", pid: 2 },
            patches: [
                { id: "p1", module: "game.exe", rva: "0x10", patchedBytes: "cc" }, // same site, changed bytes
                { id: "p2", module: "game.exe", rva: "0x40", patchedBytes: "90" }, // only in b
            ],
            watches: [{ id: "w1", expression: "game.exe+0x20" }],
        });
        const c = compareBundles(a, b);
        expect(c.targetMatch).toBe(false);
        expect(c.patchByteChanges).toEqual(["game.exe+0x10"]);
        expect(c.patches.onlyB).toEqual(["game.exe+0x40"]);
        expect(c.watches.common).toEqual(["game.exe+0x20"]);
    });
});

describe("project bundle — schema v2 network + migration", () => {
    it("migrates a v1 bundle (no network) forward and keeps it valid", () => {
        const v1 = { format: "web-mv.project", schemaVersion: 1, createdAt: "t", target: { key: "pid:1" }, watches: [] };
        const parsed = parseBundle(JSON.stringify(v1));
        expect(parsed.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
        expect(parsed.network).toBeUndefined();
    });

    it("round-trips a v2 bundle carrying inert network metadata", () => {
        const b = bundle({ network: [netBundle()] });
        const parsed = parseBundle(JSON.stringify(b));
        expect(parsed.network?.length).toBe(1);
        expect(parsed.network![0]!.captureHash).toBe("abc123");
        expect(parsed.network![0]!.bookmarks[0]!.frameNumber).toBe(2);
    });

    it("rejects a bundle whose schema is newer than supported (clean, no partial import)", () => {
        const future = { format: "web-mv.project", schemaVersion: PROJECT_SCHEMA_VERSION + 1, createdAt: "t", target: { key: "x" } };
        expect(() => parseBundle(JSON.stringify(future))).toThrow(/newer/);
    });

    it("rejects over-limit / invalid network metadata atomically", () => {
        const tooMany = { ...netBundle(), savedFilters: Array.from({ length: 1000 }, (_, i) => `f${i}`) };
        const b = bundle({ network: [tooMany as NetworkCaptureBundle] });
        expect(() => parseBundle(JSON.stringify(b))).toThrow();
        const badRef = { ...netBundle(), bookmarks: [{ captureHash: "", frameNumber: -1 }] };
        expect(() => parseBundle(JSON.stringify(bundle({ network: [badRef as unknown as NetworkCaptureBundle] })))).toThrow();
        // The store displays a single imported capture, so the schema caps network at 1.
        expect(() => parseBundle(JSON.stringify(bundle({ network: [netBundle(), netBundle({ captureHash: "def456" })] })))).toThrow();
    });

    it("sanitize dedups packet references deterministically by frame", () => {
        const b = sanitizeNetworkBundle({
            ...netBundle(),
            bookmarks: [
                { captureHash: "abc123", frameNumber: 5 },
                { captureHash: "abc123", frameNumber: 2 },
                { captureHash: "abc123", frameNumber: 5 },
            ],
        } as NetworkCaptureBundle);
        expect(b.bookmarks.map((r) => r.frameNumber)).toEqual([2, 5]);
    });
});
