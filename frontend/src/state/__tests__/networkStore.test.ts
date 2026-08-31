import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createNetworkStore, type TsharkTransport } from "../networkStore";
import { createTimelineStore } from "../../timeline/timelineStore";
import { TSHARK_DEFAULTS, type TsharkConfig } from "../tsharkConfig";
import { SUMMARY_COLUMNS } from "../../network/pcapParse";
import type { CapabilitiesStore } from "../capabilitiesStore";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const COL = SUMMARY_COLUMNS;
function row(fields: Partial<Record<(typeof COL)[number], string>>): string {
    return COL.map((c) => fields[c] ?? "").join("\t");
}
const SUMMARY_OUT = [
    COL.join("\t"),
    row({ "frame.number": "1", "frame.time_epoch": "1000", "frame.len": "74", "ip.src": "10.0.0.1", "ip.dst": "10.0.0.2", "_ws.col.Protocol": "TCP", "tcp.srcport": "1", "tcp.dstport": "80", "tcp.stream": "0", "_ws.col.Info": "SYN" }),
    row({ "frame.number": "2", "frame.time_epoch": "1001", "frame.len": "80", "ip.src": "10.0.0.2", "ip.dst": "10.0.0.1", "_ws.col.Protocol": "TCP", "tcp.stream": "0" }),
].join("\n");
const DISSECT_OUT = JSON.stringify([{ _source: { layers: { frame: { "frame.number": "1" }, frame_raw: ["deadbeef"] } } }]);

function fakeCaps(available: boolean): CapabilitiesStore {
    return { available: () => available, get: () => ({ available }) as never, reportVerbError: () => false } as unknown as CapabilitiesStore;
}

function setup(over?: { available?: boolean; transport?: Partial<TsharkTransport> }) {
    const timeline = createTimelineStore();
    const [config] = createSignal<TsharkConfig>({ ...TSHARK_DEFAULTS, enabled: true, tsharkPath: "C:/ws/tshark.exe", pcapDirectory: "C:/caps" });
    const sidecar = vi.fn();
    const analyzeSpy = vi.fn((_c: TsharkConfig, job: { op: string }) =>
        Promise.resolve(job.op === "dissect" ? { ok: true, op: "dissect", stdout: DISSECT_OUT } : { ok: true, op: job.op, stdout: SUMMARY_OUT, truncated: false, captureBytes: 200, captureHash: "hash-A", format: "pcapng" }),
    );
    const transport: TsharkTransport = {
        probe: over?.transport?.probe ?? (() => Promise.resolve({ ok: true, pathValid: true, runnable: true, version: "4.2.0" })),
        analyze: (over?.transport?.analyze as TsharkTransport["analyze"]) ?? (analyzeSpy as unknown as TsharkTransport["analyze"]),
    };
    const store = createNetworkStore({ config, capabilities: fakeCaps(over?.available ?? true), timeline, setSidecar: sidecar, transport });
    return { store, timeline, sidecar, analyzeSpy };
}

describe("createNetworkStore — probe & capability gating", () => {
    it("flips the tshark sidecar only when the preflight is runnable", async () => {
        await createRoot(async (dispose) => {
            const { store, sidecar } = setup();
            await tick();
            expect(sidecar).toHaveBeenCalledWith("tshark", true);
            expect(store.sidecarState()).toBe("runnable");
            dispose();
        });
    });

    it("does not flip the sidecar when tshark exists but is not runnable", async () => {
        await createRoot(async (dispose) => {
            const { store, sidecar } = setup({ transport: { probe: () => Promise.resolve({ ok: false, pathValid: true, runnable: false, error: "bad exe" }) } });
            await tick();
            expect(sidecar).toHaveBeenCalledWith("tshark", false);
            expect(store.sidecarState()).toBe("failed");
            dispose();
        });
    });

    it("refuses import/dissect/follow when the capability is unavailable", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup({ available: false });
            expect((await store.importPcap("a.pcapng")).ok).toBe(false);
            expect((await store.dissectPacket(1)).ok).toBe(false);
            expect((await store.followStream("tcp", 0)).ok).toBe(false);
            dispose();
        });
    });
});

describe("createNetworkStore — import, filter, derive", () => {
    it("imports a capture, derives endpoints/conversations, and marks liveValidated", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline } = setup();
            const r = await store.importPcap("cap.pcapng");
            expect(r.ok).toBe(true);
            expect(store.packets().length).toBe(2);
            expect(store.metadata()!.packetCount).toBe(2);
            expect(store.endpoints().length).toBe(2);
            expect(store.conversations().length).toBe(1); // one TCP stream, both directions merged
            expect(store.sidecarState()).toBe("liveValidated");
            expect(timeline.events.some((e) => e.type === "network.pcap.importCompleted")).toBe(true);
            // Summary-only events — never one event per packet.
            expect(timeline.events.filter((e) => e.source === "network").length).toBeLessThan(5);
            dispose();
        });
    });

    it("applies a display filter against the active capture", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, analyzeSpy } = setup();
            await store.importPcap("cap.pcapng");
            const r = await store.applyFilter("tcp.port==80");
            expect(r.ok).toBe(true);
            expect(store.activeFilter()).toBe("tcp.port==80");
            expect(analyzeSpy).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ op: "filter", displayFilter: "tcp.port==80" }));
            expect(timeline.events.some((e) => e.type === "network.pcap.filterApplied")).toBe(true);
            dispose();
        });
    });

    it("filter requires an imported capture first", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup();
            expect((await store.applyFilter("tcp")).ok).toBe(false);
            dispose();
        });
    });
});

describe("createNetworkStore — dissect cache & follow", () => {
    it("dissects a packet once, then serves a cache hit", async () => {
        await createRoot(async (dispose) => {
            const { store, timeline, analyzeSpy } = setup();
            await store.importPcap("cap.pcapng");
            const calls = analyzeSpy.mock.calls.length;
            const a = await store.dissectPacket(1);
            expect(a.ok).toBe(true);
            expect(store.cachedDissection(1)!.rawHex).toBe("deadbeef");
            const b = await store.dissectPacket(1);
            expect(b.cached).toBe(true);
            expect(analyzeSpy.mock.calls.length).toBe(calls + 1); // only one real dissect call
            expect(timeline.events.some((e) => e.type === "network.pcap.cacheHit")).toBe(true);
            dispose();
        });
    });

    it("follows a stream and stores directional chunks", async () => {
        await createRoot(async (dispose) => {
            const followOut = ["Node 0: a", "Node 1: b", "48656c6c6f", "\t776f726c64"].join("\n");
            const analyze = vi.fn((_c: TsharkConfig, job: { op: string }) =>
                Promise.resolve(job.op === "follow" ? { ok: true, op: "follow", stdout: followOut } : { ok: true, op: job.op, stdout: SUMMARY_OUT }),
            );
            const { store } = setup({ transport: { analyze: analyze as unknown as TsharkTransport["analyze"] } });
            await store.importPcap("cap.pcapng");
            const r = await store.followStream("tcp", 0);
            expect(r.ok).toBe(true);
            expect(store.follow()!.chunks.length).toBe(2);
            expect(store.follow()!.node0).toBe("a");
            dispose();
        });
    });

    it("discards a follow result whose capture was replaced mid-flight", async () => {
        await createRoot(async (dispose) => {
            let resolveFollow!: (v: unknown) => void;
            const pendingFollow = new Promise((r) => (resolveFollow = r));
            const analyze = vi.fn((_c: TsharkConfig, job: { op: string }) => {
                if (job.op === "follow") return pendingFollow as unknown as Promise<{ ok: boolean }>;
                return Promise.resolve({ ok: true, op: job.op, stdout: SUMMARY_OUT });
            });
            const { store } = setup({ transport: { analyze: analyze as unknown as TsharkTransport["analyze"] } });
            await store.importPcap("A.pcapng");
            const fp = store.followStream("tcp", 0); // in flight against A
            await store.importPcap("B.pcapng"); // active capture is now B
            resolveFollow({ ok: true, op: "follow", stdout: ["Node 0: x", "Node 1: y", "48"].join("\n") });
            const r = await fp;
            expect(r.ok).toBe(false); // superseded — A's stream must not paint B's pane
            expect(store.follow()).toBeUndefined();
            expect(store.activePcap()).toBe("B.pcapng");
            dispose();
        });
    });

    it("exports an inert bundle with identity + annotations, and imports it without calling tshark", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup();
            await store.importPcap("cap.pcapng");
            store.toggleBookmark(1);
            store.annotate(2, "second packet");
            store.saveFilter("tcp.port==80");
            const bundle = store.exportBundle();
            expect(bundle.length).toBe(1);
            expect(bundle[0]!.captureHash).toBe("hash-A");
            expect(bundle[0]!.filename).toBe("cap.pcapng");
            expect(bundle[0]!.bookmarks).toEqual([{ captureHash: "hash-A", frameNumber: 1 }]);
            expect(bundle[0]!.packetAnnotations[0]!.note).toBe("second packet");
            expect(bundle[0]!.savedFilters).toContain("tcp.port==80");
            // No raw packets / streams / paths persisted.
            expect(JSON.stringify(bundle[0]!)).not.toContain("stdout");

            // Fresh store: import is inert — no analyze call, source unavailable, annotations visible.
            const fresh = setup();
            const before = fresh.analyzeSpy.mock.calls.length;
            const n = fresh.store.importBundle(bundle);
            expect(n).toBe(1);
            expect(fresh.analyzeSpy.mock.calls.length).toBe(before); // NEVER launched tshark
            expect(fresh.store.imported()!.captureHash).toBe("hash-A");
            expect(fresh.store.activePcap()).toBeUndefined(); // source unavailable
            expect(fresh.store.annotationOf(2)).toBe("second packet");
            expect(fresh.store.isBookmarked(1)).toBe(true);
            await tick();
            expect(fresh.store.sidecarState()).not.toBe("liveValidated"); // import never marks live-validated
            dispose();
        });
    });

    it("relinks a matching capture (hash match) and preserves annotations by frame", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup();
            await store.importPcap("cap.pcapng");
            store.annotate(2, "kept");
            const bundle = store.exportBundle();
            const fresh = setup();
            fresh.store.importBundle(bundle);
            const r = await fresh.store.relinkCapture("cap.pcapng"); // mock returns hash-A → matches
            expect(r.ok).toBe(true);
            expect(fresh.store.imported()).toBeUndefined();
            expect(fresh.store.activePcap()).toBe("cap.pcapng");
            expect(fresh.store.annotationOf(2)).toBe("kept"); // preserved by frame identity
            dispose();
        });
    });

    it("importBundle count reflects exactly what was loaded (never overstates)", async () => {
        await createRoot(async (dispose) => {
            const { store } = setup();
            const one = [{
                schemaVersion: 1 as const, captureHash: "hash-A", packetCount: 1, protocols: [], endpoints: [], conversations: [],
                bookmarks: [], packetAnnotations: [{ ref: { captureHash: "hash-A", frameNumber: 1 }, note: "x" }], captureAnnotations: [], savedFilters: [], followRefs: [], truncated: false, sourceAvailable: false,
            }];
            expect(store.importBundle(one as never)).toBe(1);
            expect(store.importBundle([] as never)).toBe(0);
            dispose();
        });
    });

    it("refuses a relink whose hash does not match, unless forced", async () => {
        await createRoot(async (dispose) => {
            // Transport returns a DIFFERENT hash than the imported bundle.
            const analyze = vi.fn((_c: TsharkConfig, job: { op: string }) =>
                Promise.resolve({ ok: true, op: job.op, stdout: SUMMARY_OUT, captureHash: "hash-B", format: "pcapng" }),
            );
            const importedBundle = [{
                schemaVersion: 1 as const, captureHash: "hash-A", packetCount: 2, protocols: [], endpoints: [], conversations: [],
                bookmarks: [], packetAnnotations: [], captureAnnotations: [], savedFilters: [], followRefs: [], truncated: false, sourceAvailable: false,
            }];
            const { store } = setup({ transport: { analyze: analyze as unknown as TsharkTransport["analyze"] } });
            store.importBundle(importedBundle as never);
            const bad = await store.relinkCapture("other.pcapng");
            expect(bad.ok).toBe(false);
            expect(bad.mismatch).toBe(true);
            expect(store.imported()).toBeTruthy(); // still imported, not adopted
            const forced = await store.relinkCapture("other.pcapng", { force: true });
            expect(forced.ok).toBe(true);
            expect(store.activePcap()).toBe("other.pcapng");
            dispose();
        });
    });

    it("discards a superseded import result (stale request token)", async () => {
        await createRoot(async (dispose) => {
            let resolveFirst!: (v: unknown) => void;
            const first = new Promise((r) => (resolveFirst = r));
            let n = 0;
            const analyze = vi.fn(() => {
                n++;
                return n === 1 ? (first as unknown as Promise<{ ok: boolean }>) : Promise.resolve({ ok: true, op: "summary", stdout: SUMMARY_OUT });
            });
            const { store } = setup({ transport: { analyze: analyze as unknown as TsharkTransport["analyze"] } });
            const p1 = store.importPcap("first.pcapng");
            const p2 = store.importPcap("second.pcapng"); // supersedes #1
            await p2;
            resolveFirst({ ok: true, op: "summary", stdout: SUMMARY_OUT });
            const r1 = await p1;
            expect(r1.ok).toBe(false); // discarded as superseded
            expect(store.activePcap()).toBe("second.pcapng");
            dispose();
        });
    });
});
