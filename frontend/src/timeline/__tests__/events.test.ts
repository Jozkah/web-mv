import { describe, expect, it } from "vitest";
import {
    CURRENT_EVENT_SCHEMA_VERSION,
    timelineEventSchema,
    timelineExportSchema,
    type TimelineEvent,
} from "../events";

function goodEvent(over: Partial<TimelineEvent> = {}): TimelineEvent {
    return {
        schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
        id: "ev_1",
        sequence: 1,
        type: "relay.status",
        source: "relay",
        timestamp: "2026-01-01T00:00:00.000Z",
        severity: "info",
        summary: "Relay open",
        tags: [],
        relatedEventIds: [],
        confidence: "exact",
        provenance: "producer:relay",
        ...over,
    };
}

describe("timelineEventSchema", () => {
    it("accepts a well-formed event with optional details", () => {
        const parsed = timelineEventSchema.safeParse(goodEvent({ details: { status: "open", n: 3, ok: true } }));
        expect(parsed.success).toBe(true);
    });

    it("rejects a mismatched schema version", () => {
        const parsed = timelineEventSchema.safeParse(goodEvent({ schemaVersion: 2 as unknown as 1 }));
        expect(parsed.success).toBe(false);
    });

    it("rejects an unknown source", () => {
        const parsed = timelineEventSchema.safeParse(goodEvent({ source: "sorcery" as unknown as TimelineEvent["source"] }));
        expect(parsed.success).toBe(false);
    });

    it("round-trips through the export envelope", () => {
        const env = { schemaVersion: CURRENT_EVENT_SCHEMA_VERSION, exportedAt: "2026-01-01T00:00:00.000Z", events: [goodEvent()] };
        const parsed = timelineExportSchema.safeParse(env);
        expect(parsed.success).toBe(true);
    });
});
