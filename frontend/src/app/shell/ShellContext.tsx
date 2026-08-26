import { createContext, createEffect, createSignal, useContext, type JSX } from "solid-js";
import { load, save } from "../../state/persist";
import type { CategoryId } from "./categories";
import {
    DEFAULT_ACCENT,
    DEFAULT_BG,
    customVarNames,
    deriveAccentVars,
    deriveSurfaceVars,
    isDarkColor,
    normalizeHex,
} from "./accent";

// Chrome-level UI state for the Signal Workbench shell: which activity category is selected, the
// contextual sidebar's visibility + width, focus (Zen) mode, and the transient open/closed state
// of the command palette, Goto dialog and the Signature Scan window. Kept separate from AppContext
// (process/target/data) and WorkspaceContext (tabs) so those keep their exact behaviour; this only
// governs the surrounding frame. Sidebar width/visibility and Zen persist; overlays do not.

interface ChromePrefs {
    category: CategoryId;
    sidebarWidth: number;
    sidebarOpen: boolean;
    zen: boolean;
}

const PREFS_KEY = "ax.shell";
const PREFS_VERSION = 1;
const DEFAULTS: ChromePrefs = { category: "inspect", sidebarWidth: 232, sidebarOpen: true, zen: false };

// Themes. Stored as a RAW string under "ax.theme" (not a versioned envelope) so the tiny inline
// boot script in index.html can read it and set data-theme before first paint (no flash). The
// per-theme background here must match that script's map. "custom" is the graphite theme with a
// user-chosen accent (persisted separately under "ax.accent"); the legacy "echo" id maps to it.
export type ThemeId = "custom" | "dark" | "offwhite";
export const THEMES: { id: ThemeId; label: string; hint: string }[] = [
    { id: "offwhite", label: "Off-White", hint: "Warm, low-glare light" },
    { id: "dark", label: "Dark", hint: "Modern neutral dark" },
    { id: "custom", label: "Custom", hint: "Graphite with your accent colour" },
];
const THEME_KEY = "ax.theme";
const ACCENT_KEY = "ax.accent";
const BG_KEY = "ax.bg";
const THEME_BG: Record<ThemeId, string> = { custom: "#0c1016", dark: "#141416", offwhite: "#f2ede3" };

function loadTheme(): ThemeId {
    try {
        const t = localStorage.getItem(THEME_KEY);
        if (t === "dark" || t === "offwhite" || t === "custom") return t;
        if (t === "echo") return "custom"; // legacy id
    } catch {
        /* ignore */
    }
    return "custom";
}

function loadAccent(): string {
    try {
        return normalizeHex(localStorage.getItem(ACCENT_KEY) ?? "") ?? DEFAULT_ACCENT;
    } catch {
        return DEFAULT_ACCENT;
    }
}

function loadBackground(): string {
    try {
        return normalizeHex(localStorage.getItem(BG_KEY) ?? "") ?? DEFAULT_BG;
    } catch {
        return DEFAULT_BG;
    }
}

const CUSTOM_VAR_NAMES = customVarNames();

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 420;

function loadPrefs(): ChromePrefs {
    const saved = load<Partial<ChromePrefs>>(PREFS_KEY, PREFS_VERSION);
    if (!saved) return { ...DEFAULTS };
    return {
        category: saved.category ?? DEFAULTS.category,
        sidebarWidth: clampWidth(saved.sidebarWidth ?? DEFAULTS.sidebarWidth),
        sidebarOpen: saved.sidebarOpen ?? DEFAULTS.sidebarOpen,
        zen: saved.zen ?? DEFAULTS.zen,
    };
}

export function clampWidth(w: number): number {
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));
}

function createShellState() {
    const init = loadPrefs();
    const [category, setCategory] = createSignal<CategoryId>(init.category);
    const [sidebarWidth, setSidebarWidth] = createSignal(init.sidebarWidth);
    const [sidebarOpen, setSidebarOpen] = createSignal(init.sidebarOpen);
    const [zen, setZen] = createSignal(init.zen);

    const [paletteOpen, setPaletteOpen] = createSignal(false);
    const [gotoOpen, setGotoOpen] = createSignal(false);
    const [sigScanOpen, setSigScanOpen] = createSignal(false);
    const [theme, setThemeSig] = createSignal<ThemeId>(loadTheme());
    const [accent, setAccentSig] = createSignal<string>(loadAccent());
    const [background, setBackgroundSig] = createSignal<string>(loadBackground());

    // Reflect the theme onto <html> (data-theme drives the CSS token set) and persist it. Runs on
    // mount too, keeping the DOM in sync with the boot script. For Custom the page background and
    // colour-scheme follow the chosen background's luminance so a light custom base renders light.
    createEffect(() => {
        const t = theme();
        const el = document.documentElement;
        el.setAttribute("data-theme", t);
        if (t === "custom") {
            el.style.background = normalizeHex(background()) ?? DEFAULT_BG;
            el.style.colorScheme = isDarkColor(background()) ? "dark" : "light";
        } else {
            el.style.background = THEME_BG[t];
            el.style.colorScheme = t === "offwhite" ? "light" : "dark";
        }
        try {
            localStorage.setItem(THEME_KEY, t);
        } catch {
            /* best-effort */
        }
    });

    // The custom accent + background only apply to the Custom theme: while it is active the derived
    // variables are set inline on <html> (overriding the stylesheet defaults); for the fixed themes
    // they are cleared so each preset keeps its own palette. Persist both choices.
    createEffect(() => {
        const el = document.documentElement;
        if (theme() === "custom") {
            const vars = { ...deriveSurfaceVars(background()), ...deriveAccentVars(accent()) };
            for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
        } else {
            for (const k of CUSTOM_VAR_NAMES) el.style.removeProperty(k);
        }
    });
    createEffect(() => {
        try {
            localStorage.setItem(ACCENT_KEY, accent());
            localStorage.setItem(BG_KEY, background());
        } catch {
            /* best-effort */
        }
    });

    createEffect(() => {
        save(PREFS_KEY, PREFS_VERSION, {
            category: category(),
            sidebarWidth: sidebarWidth(),
            sidebarOpen: sidebarOpen(),
            zen: zen(),
        } satisfies ChromePrefs);
    });

    return {
        category,
        sidebarWidth,
        sidebarOpen,
        zen,
        paletteOpen,
        gotoOpen,
        sigScanOpen,
        theme,
        setTheme: (t: ThemeId) => setThemeSig(t),
        accent,
        setAccent: (hex: string) => setAccentSig(normalizeHex(hex) ?? DEFAULT_ACCENT),
        defaultAccent: DEFAULT_ACCENT,
        background,
        setBackground: (hex: string) => setBackgroundSig(normalizeHex(hex) ?? DEFAULT_BG),
        defaultBackground: DEFAULT_BG,

        // Selecting the already-active category toggles the sidebar (IDE activity-bar behaviour).
        selectCategory(id: CategoryId) {
            if (category() === id && sidebarOpen() && !zen()) {
                setSidebarOpen(false);
            } else {
                setCategory(id);
                setSidebarOpen(true);
            }
        },
        setCategory,
        toggleSidebar: () => setSidebarOpen((v) => !v),
        setSidebarOpen,
        setSidebarWidth: (w: number) => setSidebarWidth(clampWidth(w)),
        toggleZen: () => setZen((v) => !v),
        setZen,
        openPalette: () => setPaletteOpen(true),
        closePalette: () => setPaletteOpen(false),
        openGoto: () => setGotoOpen(true),
        closeGoto: () => setGotoOpen(false),
        toggleSigScan: () => setSigScanOpen((v) => !v),
        setSigScanOpen,
    };
}

export type ShellState = ReturnType<typeof createShellState>;
const ShellContext = createContext<ShellState>();

export function ShellProvider(props: { children: JSX.Element }) {
    return <ShellContext.Provider value={createShellState()}>{props.children}</ShellContext.Provider>;
}

export function useShell(): ShellState {
    const s = useContext(ShellContext);
    if (!s) throw new Error("useShell must be used within a ShellProvider");
    return s;
}
