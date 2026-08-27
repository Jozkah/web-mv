import { createSignal } from "solid-js";
import { load, save } from "./persist";

// Local tshark (Wireshark CLI) configuration for OFFLINE PCAP analysis. The user supplies a local
// tshark install — nothing is downloaded or bundled. These packets are NOT captured by this tool and
// are NOT correlated to the attached Angel target; tshark only dissects a capture file the user already
// has. Bounds (timeout, capture/output size, packet count) are enforced relay-side; surfaced here so
// the user can tune them.

export interface TsharkConfig {
    enabled: boolean;
    tsharkPath: string; // absolute path to tshark(.exe)
    pcapDirectory?: string; // guarded directory the relay reads capture files from (bare filename only)
    defaultTimeoutMs: number;
    maxCaptureBytes: number;
    maxOutputBytes: number;
    maxPackets: number;
}

export const TSHARK_DEFAULTS: TsharkConfig = {
    enabled: false,
    tsharkPath: "",
    pcapDirectory: "",
    defaultTimeoutMs: 60000,
    maxCaptureBytes: 100 * 1024 * 1024, // 100 MiB
    maxOutputBytes: 16 * 1024 * 1024, // 16 MiB of tshark stdout
    maxPackets: 5000, // packet-list cap (`-c`)
};

export const TSHARK_MAX_TIMEOUT_MS = 600000; // 10 min hard ceiling
export const TSHARK_MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
export const TSHARK_MAX_PACKETS = 200000;

export function validateTsharkConfig(c: TsharkConfig): string[] {
    const errors: string[] = [];
    if (c.enabled && c.tsharkPath.trim() === "") errors.push("tshark path is required to enable PCAP analysis");
    if (!(c.defaultTimeoutMs > 0 && c.defaultTimeoutMs <= TSHARK_MAX_TIMEOUT_MS)) errors.push(`timeout must be 1..${TSHARK_MAX_TIMEOUT_MS} ms`);
    if (!(c.maxCaptureBytes > 0 && c.maxCaptureBytes <= TSHARK_MAX_CAPTURE_BYTES)) errors.push("maxCaptureBytes out of range");
    if (!(c.maxOutputBytes > 0)) errors.push("maxOutputBytes must be positive");
    if (!(c.maxPackets > 0 && c.maxPackets <= TSHARK_MAX_PACKETS)) errors.push(`maxPackets must be 1..${TSHARK_MAX_PACKETS}`);
    return errors;
}

const KEY = "ax.tshark";
const VERSION = 1;

export function createTsharkConfig() {
    const saved = load<TsharkConfig>(KEY, VERSION);
    const [config, setConfig] = createSignal<TsharkConfig>({ ...TSHARK_DEFAULTS, ...(saved && typeof saved === "object" ? saved : {}) });

    const update = (patch: Partial<TsharkConfig>) => {
        setConfig((c) => {
            const next = { ...c, ...patch };
            save(KEY, VERSION, next);
            return next;
        });
    };
    const reset = () => {
        setConfig({ ...TSHARK_DEFAULTS });
        save(KEY, VERSION, TSHARK_DEFAULTS);
    };
    return { config, update, reset };
}

export type TsharkConfigStore = ReturnType<typeof createTsharkConfig>;
