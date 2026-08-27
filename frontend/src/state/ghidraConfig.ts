import { createSignal } from "solid-js";
import { load, save } from "./persist";

// Local Ghidra headless configuration. The user supplies a local Ghidra install — nothing is
// downloaded or bundled. The relay uses these values to run `analyzeHeadless` on an Angel-obtained
// dump. Bounds (timeout, dump/output size) are enforced relay-side so a runaway analysis can't hang
// or flood; they are surfaced here so the user can tune them.

export interface GhidraConfig {
    enabled: boolean;
    analyzeHeadlessPath: string; // absolute path to analyzeHeadless(.bat)
    projectDirectory?: string; // Ghidra project workspace (temp project is created/deleted per run)
    dumpDirectory?: string; // the Angel <scripts>/dmp folder the relay reads dumps from
    defaultTimeoutMs: number;
    maxDumpBytes: number;
    maxOutputBytes: number;
}

export const GHIDRA_DEFAULTS: GhidraConfig = {
    enabled: false,
    analyzeHeadlessPath: "",
    projectDirectory: "",
    dumpDirectory: "",
    defaultTimeoutMs: 120000,
    maxDumpBytes: 64 * 1024 * 1024, // 64 MiB
    maxOutputBytes: 16 * 1024 * 1024, // 16 MiB of decompiled JSON
};

export const GHIDRA_MAX_TIMEOUT_MS = 600000; // 10 min hard ceiling
export const GHIDRA_MAX_DUMP_BYTES = 256 * 1024 * 1024;

export function validateGhidraConfig(c: GhidraConfig): string[] {
    const errors: string[] = [];
    if (c.enabled && c.analyzeHeadlessPath.trim() === "") errors.push("analyzeHeadless path is required to enable Ghidra");
    if (!(c.defaultTimeoutMs > 0 && c.defaultTimeoutMs <= GHIDRA_MAX_TIMEOUT_MS)) errors.push(`timeout must be 1..${GHIDRA_MAX_TIMEOUT_MS} ms`);
    if (!(c.maxDumpBytes > 0 && c.maxDumpBytes <= GHIDRA_MAX_DUMP_BYTES)) errors.push("maxDumpBytes out of range");
    if (!(c.maxOutputBytes > 0)) errors.push("maxOutputBytes must be positive");
    return errors;
}

const KEY = "ax.ghidra";
const VERSION = 1;

export function createGhidraConfig() {
    const saved = load<GhidraConfig>(KEY, VERSION);
    const [config, setConfig] = createSignal<GhidraConfig>({ ...GHIDRA_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) });

    const update = (patch: Partial<GhidraConfig>) => {
        setConfig((c) => {
            const next = { ...c, ...patch };
            save(KEY, VERSION, next);
            return next;
        });
    };
    const reset = () => {
        setConfig({ ...GHIDRA_DEFAULTS });
        save(KEY, VERSION, GHIDRA_DEFAULTS);
    };
    return { config, update, reset };
}

export type GhidraConfigStore = ReturnType<typeof createGhidraConfig>;
