import { z } from "zod";
import { networkCaptureBundleSchema, type NetworkCaptureBundle } from "../network/networkBundle";

// A project bundle: the whole per-target workspace (watches, patches, cheat entries, bookmarks,
// layout, inert network metadata) plus a target fingerprint, versioned and migratable, in one
// importable file. Loading a bundle NEVER auto-applies writes/patches and NEVER launches a sidecar —
// the patch/watch stores load everything disabled/pending and network metadata loads with its source
// PCAP marked unavailable. This module is the pure schema + migration + comparison.
//
// Schema versions: v1 had no `network`; v2 adds it. A v1 bundle migrates forward (empty network); a
// version newer than we understand fails cleanly rather than importing partial/garbage state.

export const PROJECT_SCHEMA_VERSION = 2 as const;
const FORMAT = "web-mv.project";

export const targetFingerprintSchema = z.object({
    key: z.string(),
    pid: z.number().int().optional(),
    base: z.string().optional(),
    name: z.string().optional(),
    mainModuleSize: z.number().int().optional(),
});
export type TargetFingerprint = z.infer<typeof targetFingerprintSchema>;

export const projectBundleSchema = z.object({
    format: z.literal(FORMAT),
    // Accept any known version; parseBundle migrates forward and rejects unknown newer versions.
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    appVersion: z.string().optional(),
    createdAt: z.string(),
    target: targetFingerprintSchema,
    // Each section is the raw export payload of its store (validated on import by that store).
    watches: z.array(z.record(z.string(), z.unknown())).optional(),
    patches: z.array(z.record(z.string(), z.unknown())).optional(),
    cheat: z.array(z.record(z.string(), z.unknown())).optional(),
    bookmarks: z.array(z.record(z.string(), z.unknown())).optional(),
    // v2: inert Network Workbench metadata (never raw packets / streams / paths). One capture today —
    // the store displays a single imported capture, so the schema caps this at 1 (import loads what it
    // accepts; the count never overstates). Widen deliberately if multi-capture display is added.
    network: z.array(networkCaptureBundleSchema).max(1).optional(),
});
export type ProjectBundle = z.infer<typeof projectBundleSchema>;

export interface BuildBundleInput {
    createdAt: string;
    appVersion?: string;
    target: TargetFingerprint;
    watches?: unknown[];
    patches?: unknown[];
    cheat?: unknown[];
    bookmarks?: unknown[];
    network?: NetworkCaptureBundle[];
}

export function buildBundle(input: BuildBundleInput): ProjectBundle {
    return {
        format: FORMAT,
        schemaVersion: PROJECT_SCHEMA_VERSION,
        appVersion: input.appVersion,
        createdAt: input.createdAt,
        target: input.target,
        watches: input.watches as ProjectBundle["watches"],
        patches: input.patches as ProjectBundle["patches"],
        cheat: input.cheat as ProjectBundle["cheat"],
        bookmarks: input.bookmarks as ProjectBundle["bookmarks"],
        network: input.network,
    };
}

// Migrate a parsed bundle to the current schema. Older bundles are widened forward; the payload is
// otherwise untouched. (v1 → v2 simply has no network section.)
function migrate(b: ProjectBundle): ProjectBundle {
    if (b.schemaVersion === PROJECT_SCHEMA_VERSION) return b;
    return { ...b, schemaVersion: PROJECT_SCHEMA_VERSION };
}

export function parseBundle(text: string): ProjectBundle {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("project import: not valid JSON");
    }
    // Read the version first so an unknown NEWER bundle fails with a clear message instead of a generic
    // schema mismatch (and never imports partial state).
    const probe = z.object({ format: z.literal(FORMAT), schemaVersion: z.number() }).safeParse(parsed);
    if (!probe.success) throw new Error("project import: not a web-mv project bundle");
    if (probe.data.schemaVersion > PROJECT_SCHEMA_VERSION) {
        throw new Error(`project import: bundle schema v${probe.data.schemaVersion} is newer than this app supports (v${PROJECT_SCHEMA_VERSION}) — update the app`);
    }
    const res = projectBundleSchema.safeParse(parsed);
    if (!res.success) throw new Error(`project import: schema mismatch (${res.error.issues[0]?.message ?? "invalid"})`);
    return migrate(res.data);
}

// --- comparison -------------------------------------------------------------

export interface SetDiff {
    onlyA: string[];
    onlyB: string[];
    common: string[];
}

export interface ProjectComparison {
    targetMatch: boolean; // same key (same process identity)
    patches: SetDiff;
    watches: SetDiff;
    // Patch byte conflicts: same site (module+rva or expression) but different patched bytes.
    patchByteChanges: string[];
}

function idsOf(rows: readonly Record<string, unknown>[] | undefined, key: (r: Record<string, unknown>) => string): Map<string, Record<string, unknown>> {
    const m = new Map<string, Record<string, unknown>>();
    for (const r of rows ?? []) m.set(key(r), r);
    return m;
}

function setDiff(a: Set<string>, b: Set<string>): SetDiff {
    const onlyA: string[] = [];
    const onlyB: string[] = [];
    const common: string[] = [];
    for (const x of a) (b.has(x) ? common : onlyA).push(x);
    for (const x of b) if (!a.has(x)) onlyB.push(x);
    return { onlyA: onlyA.sort(), onlyB: onlyB.sort(), common: common.sort() };
}

const patchSite = (r: Record<string, unknown>): string => (r.module ? `${r.module}+${r.rva}` : String(r.expression ?? r.id));
const watchSite = (r: Record<string, unknown>): string => String(r.expression ?? r.id);

export function compareBundles(a: ProjectBundle, b: ProjectBundle): ProjectComparison {
    const pa = idsOf(a.patches, patchSite);
    const pb = idsOf(b.patches, patchSite);
    const wa = idsOf(a.watches, watchSite);
    const wb = idsOf(b.watches, watchSite);

    const patchByteChanges: string[] = [];
    for (const [site, ra] of pa) {
        const rb = pb.get(site);
        if (rb && ra.patchedBytes !== rb.patchedBytes) patchByteChanges.push(site);
    }

    return {
        targetMatch: a.target.key === b.target.key,
        patches: setDiff(new Set(pa.keys()), new Set(pb.keys())),
        watches: setDiff(new Set(wa.keys()), new Set(wb.keys())),
        patchByteChanges: patchByteChanges.sort(),
    };
}
