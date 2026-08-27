import { createEffect, createMemo, on, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { load, persist } from "./persist";
import type { AxClient } from "../transport/AxClient";
import { read, write } from "../protocol/requests";
import type { ModuleEntry } from "../protocol/types";
import type { TimelineStore } from "../timeline/timelineStore";
import type { CapabilitiesStore } from "./capabilitiesStore";
import type { TargetSession } from "./targetSession";
import { TimelineEventType, jsonDetails, type TimelineEventInput } from "../timeline/events";
import { makeModuleLookup, resolveWatchAddress } from "../watch/resolve";
import { conflictingIds, hexLen, normalizeHex, type Range } from "../patch/patchOps";
import {
    createPatch,
    freshPatchRuntime,
    migratePatch,
    validatePatch,
    type CreatePatchInput,
    type PatchDefinition,
    type PatchRuntime,
} from "../patch/model";

// Safe patch workspace. Applies raw-byte patches through the Angel `write` verb, always capturing
// and retaining the ORIGINAL bytes first so every patch is reversible. Saved patches load DISABLED
// and never auto-apply; applying is always an explicit, generation-validated action. No assembler,
// no allocation, no code caves (unavailable primitives). Conflicts (overlapping patches) are flagged.

const STORAGE_KEY = "ax.patches";
const STORAGE_VERSION = 1;

export interface PatchStoreDeps {
    client: AxClient;
    timeline: TimelineStore;
    capabilities: CapabilitiesStore;
    modules: Accessor<readonly ModuleEntry[]>;
    attached: Accessor<boolean>;
    liveKey: Accessor<string>;
    targetSession: TargetSession;
}

export type PatchAvailability = "available" | "assumed" | "unavailable";

export function createPatchStore(deps: PatchStoreDeps) {
    const nowIso = () => new Date().toISOString();
    const saved = load<{ patches: PatchDefinition[] }>(STORAGE_KEY, STORAGE_VERSION);
    const initial = (saved?.patches ?? []).map((p) => migratePatch(p)).filter((p): p is PatchDefinition => !!p);
    const [defs, setDefs] = createStore<{ list: PatchDefinition[] }>({ list: initial.map((p) => ({ ...p, enabled: false })) });
    persist(STORAGE_KEY, STORAGE_VERSION, () => ({ patches: defs.list.map((p) => ({ ...p })) }));

    const [rt, setRt] = createStore<{ map: Record<string, PatchRuntime> }>({ map: {} });
    for (const p of initial) setRt("map", p.id, { ...freshPatchRuntime(), status: "pending" });

    const capAvail = createMemo(() => deps.capabilities.get("patch.rawBytes"));
    const availability = createMemo<PatchAvailability>(() => {
        const s = capAvail();
        if (!s.available) return "unavailable";
        return s.provenance === "assumed" ? "assumed" : "available";
    });

    const byId = (id: string) => defs.list.find((p) => p.id === id);
    const runtime = (id: string): PatchRuntime => rt.map[id] ?? freshPatchRuntime();
    const patchRt = (id: string, patch: Partial<PatchRuntime>) => setRt("map", id, (cur) => ({ ...(cur ?? freshPatchRuntime()), ...patch }));

    const emit = (input: TimelineEventInput) => deps.timeline.ingest(input);
    const patchEvent = (p: PatchDefinition, type: string, severity: TimelineEventInput["severity"], summary: string, details?: Record<string, unknown>): TimelineEventInput => ({
        type,
        source: "patch",
        severity,
        summary,
        address: runtime(p.id).resolvedAddress,
        provenance: "Angel write",
        confidence: "exact",
        targetGeneration: deps.targetSession.generation(),
        tags: ["patch", ...p.tags],
        details: jsonDetails({ patchId: p.id, name: p.name, expression: p.expression, ...details }),
    });

    const resolveAddr = (p: PatchDefinition): string | undefined => {
        const lookup = makeModuleLookup(deps.modules().map((m) => ({ name: m.name, base: m.base })));
        const r = resolveWatchAddress(p.expression, lookup);
        return r.ok ? r.address : undefined;
    };

    // Conflicts: overlapping ranges among APPLIED patches (resolved addresses + patched byte length).
    const conflicts = createMemo(() => {
        const ranges: Range[] = [];
        for (const p of defs.list) {
            const r = runtime(p.id);
            if (r.status !== "applied" || !r.resolvedAddress) continue;
            ranges.push({ id: p.id, start: BigInt(r.resolvedAddress), length: hexLen(p.patchedBytes) });
        }
        return conflictingIds(ranges);
    });

    async function readBytes(address: string, len: number): Promise<string | undefined> {
        const res = await read(deps.client, { address, size: len });
        return res.success ? normalizeHex(res.data) : undefined;
    }

    function guard(): string | null {
        if (availability() === "unavailable") return "memory.write capability unavailable (extension agent not connected)";
        if (!deps.attached()) return "no target attached";
        return null;
    }

    // Apply a patch: capture original bytes on first apply, then write the patched bytes. The caller
    // (UI) confirms the destructive write showing old vs new bytes first.
    async function apply(id: string): Promise<string | null> {
        const p = byId(id);
        if (!p) return "unknown patch";
        const g = guard();
        if (g) { patchRt(id, { status: "error", error: g }); return g; }
        const gen = deps.targetSession.generation();
        const addr = resolveAddr(p);
        if (!addr) { patchRt(id, { status: "error", error: "address did not resolve" }); return "address did not resolve"; }
        const len = hexLen(p.patchedBytes);
        if (len === 0) return "empty patch";

        patchRt(id, { resolvedAddress: addr, status: "idle" });
        // Capture original bytes once (retained for restore) if not already stored.
        let original = p.originalBytes;
        if (!original) {
            original = await readBytes(addr, len);
            if (!original) { patchRt(id, { status: "error", error: "could not read original bytes" }); return "could not read original bytes"; }
            setDefs("list", (l) => l.map((x) => (x.id === id ? { ...x, originalBytes: original, targetKey: deps.liveKey() } : x)));
        }
        if (deps.targetSession.isStale(gen)) { patchRt(id, { status: "stale" }); return "target changed"; }

        const res = await write(deps.client, { address: addr, data: p.patchedBytes });
        if (deps.targetSession.isStale(gen)) { patchRt(id, { status: "stale" }); return "target changed"; }
        if (!res.success) {
            patchRt(id, { status: "error", error: "write failed" });
            emit(patchEvent(p, TimelineEventType.PatchFailed, "warning", `Patch write failed: ${p.name}`));
            return "write failed";
        }
        setDefs("list", (l) => l.map((x) => (x.id === id ? { ...x, enabled: true } : x)));
        patchRt(id, { status: "applied", currentBytes: p.patchedBytes, lastAppliedAt: nowIso(), generation: gen, error: undefined });
        emit(patchEvent(p, TimelineEventType.PatchApplied, "notice", `Patch applied: ${p.name} @ ${addr}`, { original, patched: p.patchedBytes, bytes: len }));
        return null;
    }

    // Restore original bytes.
    async function restore(id: string): Promise<string | null> {
        const p = byId(id);
        if (!p || !p.originalBytes) return "no original bytes to restore";
        const g = guard();
        if (g) return g;
        const gen = deps.targetSession.generation();
        const addr = runtime(id).resolvedAddress ?? resolveAddr(p);
        if (!addr) return "address did not resolve";
        const res = await write(deps.client, { address: addr, data: p.originalBytes });
        if (deps.targetSession.isStale(gen)) { patchRt(id, { status: "stale" }); return "target changed"; }
        if (!res.success) { patchRt(id, { status: "error", error: "restore write failed" }); return "restore failed"; }
        setDefs("list", (l) => l.map((x) => (x.id === id ? { ...x, enabled: false } : x)));
        patchRt(id, { status: "restored", currentBytes: p.originalBytes });
        emit(patchEvent(p, TimelineEventType.PatchRestored, "info", `Patch restored: ${p.name}`));
        return null;
    }

    // Toggling enabled is the CE-style checkbox: on = apply, off = restore. Never auto-runs.
    async function setEnabled(id: string, on: boolean): Promise<string | null> {
        return on ? apply(id) : restore(id);
    }

    function add(input: CreatePatchInput): string {
        const lookup = makeModuleLookup(deps.modules().map((m) => ({ name: m.name, base: m.base })));
        const r = resolveWatchAddress(input.expression, lookup);
        const p = createPatch({ ...input, module: r.moduleRef?.module, rva: r.moduleRef?.offset, targetKey: deps.liveKey(), nowIso: nowIso() });
        const v = validatePatch(p);
        if (!v.ok) throw new Error(v.errors.join("; "));
        setDefs("list", (l) => [...l, p]);
        setRt("map", p.id, freshPatchRuntime());
        emit(patchEvent(p, TimelineEventType.PatchCreated, "debug", `Patch created: ${p.name}`));
        return p.id;
    }

    function update(id: string, patch: Partial<PatchDefinition>): void {
        const p = byId(id);
        if (!p) return;
        // Editing patched bytes on an applied patch would desync original length; only allow when idle.
        const next = { ...p, ...patch, updatedAt: nowIso() };
        if (patch.patchedBytes !== undefined) next.patchedBytes = normalizeHex(patch.patchedBytes) ?? p.patchedBytes;
        if (!validatePatch(next).ok) return;
        setDefs("list", (l) => l.map((x) => (x.id === id ? next : x)));
    }

    async function remove(id: string): Promise<void> {
        const p = byId(id);
        if (p && runtime(id).status === "applied") await restore(id).catch(() => {});
        setDefs("list", (l) => l.filter((x) => x.id !== id));
        if (p) emit(patchEvent(p, TimelineEventType.PatchRemoved, "debug", `Patch removed: ${p.name}`));
    }

    async function restoreAll(): Promise<void> {
        for (const p of defs.list) if (runtime(p.id).status === "applied") await restore(p.id).catch(() => {});
    }

    // A target-generation change marks applied patches stale (we never blind-write the old bytes to a
    // new process). The user must re-apply explicitly after verifying identity.
    createEffect(
        on(deps.targetSession.generation, () => {
            let any = false;
            for (const p of defs.list) {
                if (runtime(p.id).status === "applied") { patchRt(p.id, { status: "stale" }); any = true; }
            }
            if (any) setDefs("list", (l) => l.map((x) => ({ ...x, enabled: false })));
        }, { defer: true }),
    );

    function exportJSON(ids?: string[]): string {
        const list = ids ? defs.list.filter((p) => ids.includes(p.id)) : defs.list;
        return JSON.stringify({ schemaVersion: STORAGE_VERSION, patches: list }, null, 2);
    }
    function importJSON(text: string): number {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw new Error("patch import: not valid JSON"); }
        const arr = (parsed as { patches?: unknown }).patches;
        if (!Array.isArray(arr)) throw new Error("patch import: missing patches array");
        let added = 0;
        for (const raw of arr) {
            const p = migratePatch(raw);
            if (!p) continue;
            // Imported patches load disabled/pending and never auto-apply.
            const imported: PatchDefinition = { ...p, id: createPatch({ expression: p.expression, patchedBytes: p.patchedBytes }).id, enabled: false, targetKey: undefined };
            setDefs("list", (l) => [...l, imported]);
            setRt("map", imported.id, { ...freshPatchRuntime(), status: "pending" });
            added++;
        }
        return added;
    }

    return {
        patches: () => defs.list,
        runtime,
        byId,
        add,
        update,
        remove,
        apply,
        restore,
        restoreAll,
        setEnabled,
        conflicts,
        availability,
        capStatus: capAvail,
        resolveAddr,
        exportJSON,
        importJSON,
    };
}

export type PatchStore = ReturnType<typeof createPatchStore>;
