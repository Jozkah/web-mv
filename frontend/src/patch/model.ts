import { normalizeHex } from "./patchOps";

// Serializable patch definition. A patch always stores its ORIGINAL bytes (captured from the live
// target before the first apply) alongside the PATCHED bytes, so it is always reversible. Address is
// kept both as the entered expression and, when it resolved inside a module, as a portable
// module+rva identity (absolute-address patches carry relocation risk). No assembler — bytes only.

export const PATCH_SCHEMA_VERSION = 1 as const;

export type PatchStatus = "idle" | "applied" | "restored" | "error" | "stale" | "conflict" | "pending";

export interface PatchDefinition {
    schemaVersion: typeof PATCH_SCHEMA_VERSION;
    id: string;
    name: string;
    enabled: boolean;
    groupId?: string;
    expression: string; // entered address expression
    module?: string; // resolved module name (portable identity)
    rva?: string; // hex offset within the module
    patchedBytes: string; // hex (lowercase, no 0x)
    originalBytes?: string; // hex captured from the target before first apply (undefined until captured)
    notes?: string;
    tags: string[];
    targetKey?: string; // fingerprint of the target this patch was created/applied under
    createdAt: string;
    updatedAt: string;
}

export interface PatchGroup {
    id: string;
    name: string;
    enabled: boolean;
}

export interface PatchRuntime {
    status: PatchStatus;
    resolvedAddress?: string;
    currentBytes?: string; // last live read at the patch site
    lastAppliedAt?: string;
    generation?: number;
    error?: string;
}

export function freshPatchRuntime(): PatchRuntime {
    return { status: "idle" };
}

export const MAX_PATCH_BYTES = 4096;
export const MAX_PATCH_NAME = 120;

export interface PatchValidation {
    ok: boolean;
    errors: string[];
}

export function validatePatch(def: Partial<PatchDefinition>): PatchValidation {
    const errors: string[] = [];
    if (!def.name || def.name.trim() === "") errors.push("name is required");
    if (def.name && def.name.length > MAX_PATCH_NAME) errors.push("name too long");
    if (!def.expression || def.expression.trim() === "") errors.push("address expression is required");
    const patched = def.patchedBytes ? normalizeHex(def.patchedBytes) : undefined;
    if (!patched) errors.push("patched bytes must be valid hex (even length)");
    else if (patched.length >> 1 > MAX_PATCH_BYTES) errors.push(`patch exceeds ${MAX_PATCH_BYTES} bytes`);
    if (def.originalBytes !== undefined) {
        const orig = normalizeHex(def.originalBytes);
        if (!orig) errors.push("original bytes must be valid hex");
        else if (patched && orig.length !== patched.length) errors.push("original and patched byte lengths differ");
    }
    return { ok: errors.length === 0, errors };
}

let idSeq = 0;
export function nextPatchId(): string {
    idSeq++;
    return `patch_${Date.now().toString(36)}_${idSeq}`;
}

export interface CreatePatchInput {
    name?: string;
    expression: string;
    patchedBytes: string;
    module?: string;
    rva?: string;
    groupId?: string;
    notes?: string;
    tags?: string[];
    targetKey?: string;
    nowIso?: string;
}

export function createPatch(input: CreatePatchInput): PatchDefinition {
    const now = input.nowIso ?? new Date().toISOString();
    return {
        schemaVersion: PATCH_SCHEMA_VERSION,
        id: nextPatchId(),
        name: input.name?.trim() || input.expression.trim(),
        enabled: false, // patches never auto-apply; enabling + applying is always explicit
        groupId: input.groupId,
        expression: input.expression.trim(),
        module: input.module,
        rva: input.rva,
        patchedBytes: normalizeHex(input.patchedBytes) ?? "",
        tags: input.tags ?? [],
        notes: input.notes,
        targetKey: input.targetKey,
        createdAt: now,
        updatedAt: now,
    };
}

export function migratePatch(raw: unknown): PatchDefinition | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    if (r.schemaVersion !== PATCH_SCHEMA_VERSION) return undefined;
    if (!validatePatch(r as Partial<PatchDefinition>).ok) return undefined;
    return r as unknown as PatchDefinition;
}
