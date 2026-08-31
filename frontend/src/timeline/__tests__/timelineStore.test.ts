import { describe, expect, it } from "vitest";
import { createEffect, createRoot } from "solid-js";
import {
    MAX_TIMELINE_EVENTS,
    createTimelineStore,
    eventMatchesFilter,
    filterEvents,
    groupEvents,
} from "../timelineStore";
import type { TimelineEvent, TimelineEventInput } from "../events";

function ev(over: Partial<TimelineEvent> = {}): TimelineEvent {
    return {
        schemaVersion: 1,
        id: over.id ?? "ev_x",
        sequence: over.sequence ?? 1,
        type: over.type ?? "relay.status",
        source: over.source ?? "relay",
        timestamp: over.timestamp ?? "2026-01-01T00:00:00.000Z",
        severity: over.severity ?? "info",
        summary: over.summary ?? "Relay open",
        tags: over.tags ?? [],
        relatedEventIds: over.relatedEventIds ?? [],
        confidence: over.confidence ?? "exact",
        provenance: over.provenance ?? "p",
        ...over,
    };
}

const input = (over: Partial<TimelineEventInput> = {}): TimelineEventInput => ({
    type: over.type ?? "relay.status",
    source: over.source ?? "relay",
    severity: over.severity ?? "info",
    summary: over.summary ?? "hello",
    ...over,
});

describe("pure filter / group", () => {
    it("filters by source, severity floor, text, and generation", () => {
        const events = [
            ev({ id: "a", type: "relay.status", source: "relay", severity: "info", summary: "Relay open", targetGeneration: 1 }),
            ev({ id: "b", type: "agent.core.status", source: "agent", severity: "warning", summary: "Core disconnected", targetGeneration: 1 }),
            ev({ id: "c", type: "module.listLoaded", source: "target", severity: "debug", summary: "Module list", targetGeneration: 2 }),
        ];
        expect(filterEvents(events, { sources: ["agent"] }, 2).map((e) => e.id)).toEqual(["b"]);
        expect(filterEvents(events, { minSeverity: "warning" }, 2).map((e) => e.id)).toEqual(["b"]);
        expect(filterEvents(events, { text: "open" }, 2).map((e) => e.id)).toEqual(["a"]);
        expect(filterEvents(events, { generation: "current" }, 2).map((e) => e.id)).toEqual(["c"]);
        expect(filterEvents(events, { generation: 1 }, 2).map((e) => e.id)).toEqual(["a", "b"]);
    });

    it("groups by source", () => {
        const events = [ev({ id: "a", source: "relay" }), ev({ id: "b", source: "agent" }), ev({ id: "c", source: "relay" })];
        const groups = groupEvents(events, "source");
        const relay = groups.find((g) => g.key === "relay");
        expect(relay?.events.map((e) => e.id)).toEqual(["a", "c"]);
    });

    it("eventMatchesFilter respects an empty filter (all pass)", () => {
        expect(eventMatchesFilter(ev(), {}, 0)).toBe(true);
    });
});

describe("createTimelineStore", () => {
    it("ingest assigns monotonic sequence, id, and stamps the current generation", () => {
        createRoot((dispose) => {
            const tl = createTimelineStore();
            tl.setGeneration(7);
            const a = tl.ingest(input({ summary: "one" }));
            const b = tl.ingest(input({ summary: "two" }));
            expect(a.sequence).toBe(1);
            expect(b.sequence).toBe(2);
            expect(a.id).toBe("ev_1");
            expect(a.targetGeneration).toBe(7);
            expect(tl.count()).toBe(2);
            dispose();
        });
    });

    it("enforces bounded retention, dropping oldest and counting them", () => {
        createRoot((dispose) => {
            const tl = createTimelineStore();
            const extra = 25;
            for (let i = 0; i < MAX_TIMELINE_EVENTS + extra; i++) tl.ingest(input({ summary: `e${i}` }));
            expect(tl.count()).toBe(MAX_TIMELINE_EVENTS);
            expect(tl.dropped()).toBe(extra);
            // The very first events were dropped; the oldest surviving is e{extra}.
            expect(tl.events[0].summary).toBe(`e${extra}`);
            dispose();
        });
    });

    it("scopes events by target generation (isolation)", () => {
        createRoot((dispose) => {
            const tl = createTimelineStore();
            tl.setGeneration(1);
            tl.ingest(input({ summary: "gen1" }));
            tl.setGeneration(2);
            tl.ingest(input({ summary: "gen2" }));
            tl.setFilter({ generation: "current" });
            expect(tl.filtered().map((e) => e.summary)).toEqual(["gen2"]);
            dispose();
        });
    });

    it("correlates events bidirectionally", () => {
        createRoot((dispose) => {
            const tl = createTimelineStore();
            const a = tl.ingest(input({ summary: "a" }));
            const b = tl.ingest(input({ summary: "b" }));
            tl.link(a.id, b.id);
            expect(tl.related(a.id).map((e) => e.id)).toContain(b.id);
            expect(tl.related(b.id).map((e) => e.id)).toContain(a.id);
            dispose();
        });
    });

    it("exports and re-imports, remapping ids and preserving links + tagging imported", () => {
        createRoot((dispose) => {
            const tl = createTimelineStore();
            const a = tl.ingest(input({ summary: "a" }));
            const b = tl.ingest(input({ summary: "b" }));
            tl.link(a.id, b.id);
            const json = tl.exportJSON();

            const n = tl.importJSON(json);
            expect(n).toBe(2);
            expect(tl.count()).toBe(4); // originals + imported copies
            const imported = tl.events.filter((e) => e.tags.includes("imported"));
            expect(imported.length).toBe(2);
            // The imported pair keeps its internal link (remapped to fresh ids, not the originals).
            const impA = imported.find((e) => e.summary === "a")!;
            const impB = imported.find((e) => e.summary === "b")!;
            expect(impA.relatedEventIds).toContain(impB.id);
            expect(impA.relatedEventIds).not.toContain(a.id);
            dispose();
        });
    });

    it("stays bounded and filters fast under a large ingest burst", () => {
        createRoot((dispose) => {
            const tl = createTimelineStore();
            const N = 20000;
            const t0 = performance.now();
            for (let i = 0; i < N; i++) {
                tl.ingest(input({ source: i % 2 === 0 ? "relay" : "agent", summary: `e${i}`, severity: i % 5 === 0 ? "warning" : "info" }));
            }
            // Never materializes more than the retention cap regardless of how many were ingested.
            expect(tl.count()).toBe(MAX_TIMELINE_EVENTS);
            expect(tl.dropped()).toBe(N - MAX_TIMELINE_EVENTS);
            // A full-buffer filter pass is linear over the bounded set.
            const warnings = filterEvents(tl.events, { minSeverity: "warning", sources: ["agent"] }, tl.currentGeneration());
            expect(warnings.every((e) => e.source === "agent" && e.severity === "warning")).toBe(true);
            const elapsed = performance.now() - t0;
            // Generous ceiling — asserts the ingest+filter path is not accidentally quadratic.
            expect(elapsed).toBeLessThan(5000);
            dispose();
        });
    });

    it("ingestMany assigns ordered sequences and preserves generation stamps", () => {
        createRoot((dispose) => {
            const tl = createTimelineStore();
            tl.setGeneration(3);
            const out = tl.ingestMany([
                input({ summary: "a" }),
                input({ summary: "b", targetGeneration: 99 }),
                input({ summary: "c" }),
            ]);
            expect(out.map((e) => e.sequence)).toEqual([1, 2, 3]);
            expect(out[0].targetGeneration).toBe(3); // stamped from current generation
            expect(out[1].targetGeneration).toBe(99); // producer-supplied stamp preserved
            expect(tl.count()).toBe(3);
            dispose();
        });
    });

    it("ingestMany bumps the reactive version exactly once per batch", async () => {
        await createRoot(async (dispose) => {
            const tl = createTimelineStore();
            let runs = 0;
            createEffect(() => {
                tl.filtered(); // subscribe to the reactive version
                runs++;
            });
            await new Promise<void>((r) => setTimeout(r, 0)); // flush the initial effect run
            const before = runs;
            tl.ingestMany(Array.from({ length: 250 }, (_, i) => input({ summary: `e${i}` })));
            await new Promise<void>((r) => setTimeout(r, 0));
            expect(runs - before).toBe(1); // one recomputation for the whole 250-event batch
            dispose();
        });
    });

    it("ingestMany applies retention once across a batch larger than the cap", () => {
        createRoot((dispose) => {
            const tl = createTimelineStore();
            const batch = Array.from({ length: MAX_TIMELINE_EVENTS + 40 }, (_, i) => input({ summary: `e${i}` }));
            tl.ingestMany(batch);
            expect(tl.count()).toBe(MAX_TIMELINE_EVENTS);
            expect(tl.dropped()).toBe(40);
            dispose();
        });
    });

    it("rejects invalid import payloads without partial state", () => {
        createRoot((dispose) => {
            const tl = createTimelineStore();
            expect(() => tl.importJSON("{ not json")).toThrow();
            expect(() => tl.importJSON(JSON.stringify({ schemaVersion: 1, exportedAt: "x", events: [{ bad: true }] }))).toThrow();
            expect(tl.count()).toBe(0);
            dispose();
        });
    });
});
