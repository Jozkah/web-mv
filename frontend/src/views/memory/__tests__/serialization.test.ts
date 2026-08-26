import { describe, expect, it } from "vitest";
import {
    buildNodes,
    MEMORY_STORAGE_LEGACY_VERSION,
    MEMORY_STORAGE_VERSION,
    migrateSavedPayload,
    sanitizeSavedClass,
    sanitizeSavedNode,
    sanitizeSavedState,
    serializeNode,
} from "../state/classSerialization";
import { createNode } from "../nodes/layout";

// Persistence schema: v2 payloads (the shipped format) must hydrate under v3, v3-only fields
// must round-trip, and structurally broken payloads must be discarded whole - never partially.

const V2_PAYLOAD = {
    classes: [
        {
            name: "Player",
            address: "0x1400000",
            nodes: [
                { typeId: "int32", name: "health" },
                { typeId: "fill8" },
                { typeId: "string", name: "tag", length: 16 },
            ],
        },
    ],
    activeIndex: 0,
    expandedPaths: ["n1"],
};

describe("migration from v2", () => {
    it("accepts a v2 envelope and hydrates it unchanged", () => {
        const state = migrateSavedPayload({ v: MEMORY_STORAGE_LEGACY_VERSION, data: V2_PAYLOAD });
        expect(state).toBeDefined();
        expect(state!.classes[0].name).toBe("Player");
        expect(state!.classes[0].nodes).toHaveLength(3);
        expect(state!.expandedPaths).toEqual(["n1"]);
        expect(state!.settings).toBeUndefined();
    });

    it("accepts the current version too and rejects anything else", () => {
        expect(migrateSavedPayload({ v: MEMORY_STORAGE_VERSION, data: V2_PAYLOAD })).toBeDefined();
        expect(migrateSavedPayload({ v: 1, data: V2_PAYLOAD })).toBeUndefined();
        expect(migrateSavedPayload(undefined)).toBeUndefined();
    });
});

describe("sanitizeSavedNode", () => {
    it("keeps the v3 per-node overrides", () => {
        const n = sanitizeSavedNode({
            typeId: "bits8",
            name: "flags",
            displayFormat: "hex",
            endian: "be",
            bitNames: ["A", "", "C"],
            locked: true,
        });
        expect(n).toEqual({
            typeId: "bits8",
            name: "flags",
            displayFormat: "hex",
            endian: "be",
            bitNames: ["A", "", "C"],
            locked: true,
        });
    });

    it("drops unknown display formats and non-boolean locks", () => {
        const n = sanitizeSavedNode({ typeId: "int32", displayFormat: "roman", locked: "yes" });
        expect(n).toEqual({ typeId: "int32" });
    });

    it("rejects unknown type ids", () => {
        expect(sanitizeSavedNode({ typeId: "quaternion" })).toBeUndefined();
    });

    it("requires a byte span on variable-size types", () => {
        expect(sanitizeSavedNode({ typeId: "string" })).toBeUndefined();
        expect(sanitizeSavedNode({ typeId: "structref", refName: "Vec" })).toBeUndefined();
        expect(sanitizeSavedNode({ typeId: "structref", refName: "Vec", length: 12 })).toBeDefined();
    });

    it("requires a refName on registry refs but tolerates a missing definition", () => {
        expect(sanitizeSavedNode({ typeId: "enumref", length: 4 })).toBeUndefined();
        // "Missing" here means the registry has no such enum - still hydrates; the row renders
        // a missing-reference state instead of crashing.
        expect(sanitizeSavedNode({ typeId: "enumref", refName: "NoSuchEnum", length: 4 })).toBeDefined();
    });
});

describe("sanitizeSavedState", () => {
    it("is all-or-nothing over classes", () => {
        const bad = {
            classes: [
                V2_PAYLOAD.classes[0],
                { name: "Broken", address: "0x1", nodes: [{ typeId: "nope" }] },
            ],
            activeIndex: 0,
        };
        expect(sanitizeSavedState(bad)).toBeUndefined();
    });

    it("clamps a bad activeIndex and keeps settings booleans only", () => {
        const state = sanitizeSavedState({
            classes: V2_PAYLOAD.classes,
            activeIndex: 99,
            settings: { autoGuess: false, autoGrow: "yes" },
        });
        expect(state!.activeIndex).toBe(0);
        expect(state!.settings).toEqual({ autoGuess: false });
    });

    it("per-class sanitize supports import's skip-bad-class behavior", () => {
        expect(sanitizeSavedClass(V2_PAYLOAD.classes[0])).toBeDefined();
        expect(sanitizeSavedClass({ name: "X", address: "0x1", nodes: [{ typeId: "nope" }] })).toBeUndefined();
    });
});

describe("round-trip", () => {
    it("serializeNode -> sanitize -> buildNodes preserves the durable shape", () => {
        const original = createNode("enumref", "team", 4, {
            refName: "Team",
            displayFormat: "dec",
            locked: true,
        });
        const saved = serializeNode(original);
        const clean = sanitizeSavedNode(saved);
        expect(clean).toBeDefined();
        const [rebuilt] = buildNodes({ name: "C", address: "", nodes: [clean!] });
        expect(rebuilt.typeId).toBe("enumref");
        expect(rebuilt.refName).toBe("Team");
        expect(rebuilt.length).toBe(4);
        expect(rebuilt.displayFormat).toBe("dec");
        expect(rebuilt.locked).toBe(true);
        expect(rebuilt.id).not.toBe(original.id); // ids are re-minted on hydrate
    });

    it("a plain v2-shaped node serializes without any v3 keys", () => {
        const saved = serializeNode(createNode("int32", "health"));
        expect(saved).toEqual({ typeId: "int32", name: "health" });
    });
});
