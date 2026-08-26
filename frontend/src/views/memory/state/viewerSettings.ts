import { createStore } from "solid-js/store";
import { load, persist } from "../../../state/persist";

// Viewer-level live-inspection settings: poll cadence, preferred pause state, and the pointer
// preview policy. These are preferences about HOW to watch memory (not what the user built),
// so they persist globally rather than per workspace. Snapshot bytes and baselines are
// transient by design and never stored - a reload always re-reads live memory.

export type PreviewMode = "expanded" | "visible" | "all";

export const REFRESH_INTERVALS = [100, 250, 500, 1000] as const;
export const PREVIEW_BUDGETS = [4, 8, 16, 32, 64] as const;

export const PREVIEW_MODES: readonly { id: PreviewMode; label: string }[] = [
    { id: "expanded", label: "Expanded only" },
    { id: "visible", label: "Visible" },
    { id: "all", label: "All" },
];

export interface ViewerSettings {
    intervalMs: number;
    /** Preferred initial pause state; the frozen snapshot itself is never restored. */
    startPaused: boolean;
    previewMode: PreviewMode;
    /** Max unique pointer targets peeked per polling cycle. */
    maxPreviews: number;
}

const STORAGE_KEY = "ax.memviewer";
const STORAGE_VERSION = 1;

const DEFAULTS: ViewerSettings = {
    intervalMs: 250,
    startPaused: false,
    previewMode: "expanded",
    maxPreviews: 16,
};

function sanitize(raw: unknown): ViewerSettings {
    const s = raw as Partial<ViewerSettings> | null;
    if (!s || typeof s !== "object") return { ...DEFAULTS };
    return {
        intervalMs: REFRESH_INTERVALS.includes(s.intervalMs as (typeof REFRESH_INTERVALS)[number])
            ? (s.intervalMs as number)
            : DEFAULTS.intervalMs,
        startPaused: s.startPaused === true,
        previewMode:
            s.previewMode === "expanded" || s.previewMode === "visible" || s.previewMode === "all"
                ? s.previewMode
                : DEFAULTS.previewMode,
        maxPreviews: PREVIEW_BUDGETS.includes(s.maxPreviews as (typeof PREVIEW_BUDGETS)[number])
            ? (s.maxPreviews as number)
            : DEFAULTS.maxPreviews,
    };
}

export function createViewerSettings() {
    const [settings, setSettings] = createStore<ViewerSettings>(
        sanitize(load<ViewerSettings>(STORAGE_KEY, STORAGE_VERSION)),
    );

    persist(STORAGE_KEY, STORAGE_VERSION, () => ({
        intervalMs: settings.intervalMs,
        startPaused: settings.startPaused,
        previewMode: settings.previewMode,
        maxPreviews: settings.maxPreviews,
    }));

    return {
        settings,
        setIntervalMs: (ms: number) => setSettings("intervalMs", ms),
        setStartPaused: (paused: boolean) => setSettings("startPaused", paused),
        setPreviewMode: (mode: PreviewMode) => setSettings("previewMode", mode),
        setMaxPreviews: (n: number) => setSettings("maxPreviews", n),
    };
}

export type ViewerSettingsState = ReturnType<typeof createViewerSettings>;
