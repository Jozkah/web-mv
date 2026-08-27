import { describe, expect, it } from "vitest";
import {
    createWatch,
    migrateDefinition,
    validateDefinition,
    watchReadSize,
    WATCH_SCHEMA_VERSION,
} from "../model";

describe("createWatch / validateDefinition", () => {
    it("creates a valid v1 watch with sane defaults", () => {
        const w = createWatch({ expression: "client.dll+0x10", nowIso: "2026-01-01T00:00:00.000Z" });
        expect(w.schemaVersion).toBe(WATCH_SCHEMA_VERSION);
        expect(w.valueType).toBe("int32");
        expect(w.intervalMs).toBe(500);
        expect(w.historyLimit).toBe(256);
        expect(validateDefinition(w).ok).toBe(true);
    });

    it("requires a byte length for string/bytes types", () => {
        const w = createWatch({ expression: "0x1000", valueType: "ascii", byteLength: undefined });
        // createWatch defaults a byteLength for variable-length types, so it validates…
        expect(validateDefinition(w).ok).toBe(true);
        // …but an explicit missing/zero length fails.
        expect(validateDefinition({ ...w, byteLength: 0 }).ok).toBe(false);
    });

    it("rejects out-of-range interval and history limits", () => {
        const w = createWatch({ expression: "0x1000" });
        expect(validateDefinition({ ...w, intervalMs: 5 }).ok).toBe(false);
        expect(validateDefinition({ ...w, historyLimit: 1 }).ok).toBe(false);
        expect(validateDefinition({ ...w, historyLimit: 999999 }).ok).toBe(false);
    });

    it("enforces name / notes / tag size limits", () => {
        const w = createWatch({ expression: "0x1000" });
        expect(validateDefinition({ ...w, name: "x".repeat(200) }).ok).toBe(false);
        expect(validateDefinition({ ...w, notes: "n".repeat(5000) }).ok).toBe(false);
        expect(validateDefinition({ ...w, tags: Array(50).fill("t") }).ok).toBe(false);
    });

    it("computes read size for fixed and variable types", () => {
        expect(watchReadSize({ valueType: "int32" })).toBe(4);
        expect(watchReadSize({ valueType: "uint64" })).toBe(8);
        expect(watchReadSize({ valueType: "pointer" })).toBe(8);
        expect(watchReadSize({ valueType: "ascii", byteLength: 32 })).toBe(32);
    });
});

describe("migrateDefinition", () => {
    it("accepts a valid v1 record", () => {
        const w = createWatch({ expression: "0x1000" });
        expect(migrateDefinition(w)).toBeTruthy();
    });
    it("rejects unknown/newer schema versions and invalid records", () => {
        const w = createWatch({ expression: "0x1000" });
        expect(migrateDefinition({ ...w, schemaVersion: 2 })).toBeUndefined();
        expect(migrateDefinition({ ...w, expression: "" })).toBeUndefined();
        expect(migrateDefinition(null)).toBeUndefined();
    });
});
