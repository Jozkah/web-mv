// Custom-theme derivation. From two base colours — an accent and a background — the whole token
// set is derived in the same shape the fixed themes use:
//   • accent  → hover "strong", muted "soft", alpha tints, focus, on-accent text, signal gradient
//   • background → the surface elevation ladder, hairlines, ink text (contrast-correct), scrollbar
// The SAME maths is inlined in index.html's boot script — keep them in sync so there is no flash.

export const DEFAULT_ACCENT = "#69a5c8";
export const DEFAULT_BG = "#0c1016";

export function normalizeHex(input: string): string | null {
    let h = input.trim().toLowerCase();
    if (h[0] !== "#") h = "#" + h;
    if (/^#[0-9a-f]{3}$/.test(h)) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    return /^#[0-9a-f]{6}$/.test(h) ? h : null;
}

function clamp(n: number): number {
    return Math.max(0, Math.min(255, Math.round(n)));
}
function toHex2(n: number): string {
    return clamp(n).toString(16).padStart(2, "0");
}
function rgb(hex: string): [number, number, number] {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function mixHex(hex: string, target: string, t: number): string {
    const [r, g, b] = rgb(hex);
    const [tr, tg, tb] = rgb(target);
    return `#${toHex2(r + (tr - r) * t)}${toHex2(g + (tg - g) * t)}${toHex2(b + (tb - b) * t)}`;
}
const lighten = (hex: string, t: number) => mixHex(hex, "#ffffff", t);
const darken = (hex: string, t: number) => mixHex(hex, "#000000", t);

export function luminance(hex: string): number {
    const [r, g, b] = rgb(hex);
    return 0.299 * r + 0.587 * g + 0.114 * b; // 0..255
}
export function isDarkColor(hex: string): boolean {
    return luminance(hex) < 128;
}

// Accent → the accent family.
export function deriveAccentVars(baseHex: string): Record<string, string> {
    const hex = normalizeHex(baseHex) ?? DEFAULT_ACCENT;
    const [r, g, b] = rgb(hex);
    const strong = lighten(hex, 0.22);
    const soft = darken(hex, 0.22);
    const onAccent = luminance(hex) > 150 ? "#08121a" : "#ffffff";
    return {
        "--accent": hex,
        "--accent-strong": strong,
        "--accent-soft": soft,
        "--accent-bg": `rgba(${r}, ${g}, ${b}, 0.12)`,
        "--accent-bg-strong": `rgba(${r}, ${g}, ${b}, 0.18)`,
        "--accent-line": `rgba(${r}, ${g}, ${b}, 0.42)`,
        "--accent-focus": `rgba(${r}, ${g}, ${b}, 0.55)`,
        "--on-accent": onAccent,
        "--signal": `linear-gradient(90deg, ${hex} 0%, rgba(${r}, ${g}, ${b}, 0.35) 58%, transparent 100%)`,
    };
}

// Background → the surface / line / ink family. A dark base produces a graphite ladder (deeper
// chrome darker, panels/inputs lighter); a light base flips it (chrome darker, panels toward
// white). Ink is chosen for contrast against the base either way.
export function deriveSurfaceVars(baseHex: string): Record<string, string> {
    const b = normalizeHex(baseHex) ?? DEFAULT_BG;
    const dark = isDarkColor(b);

    if (dark) {
        const ink = "#e7edf4";
        return {
            "--surface-0": darken(b, 0.38),
            "--surface-1": b,
            "--surface-2": lighten(b, 0.035),
            "--surface-3": lighten(b, 0.05),
            "--surface-4": lighten(b, 0.09),
            "--surface-float": lighten(b, 0.02),
            "--line": lighten(b, 0.12),
            "--line-soft": lighten(b, 0.06),
            "--line-strong": lighten(b, 0.17),
            "--ink": ink,
            "--ink-2": mixHex(ink, b, 0.35),
            "--ink-3": mixHex(ink, b, 0.62),
            "--social-bg": "rgba(255, 255, 255, 0.04)",
            "--scrollbar-thumb": lighten(b, 0.12),
        };
    }

    const ink = "#22221e";
    return {
        "--surface-0": darken(b, 0.06),
        "--surface-1": b,
        "--surface-2": lighten(b, 0.45),
        "--surface-3": lighten(b, 0.72),
        "--surface-4": darken(b, 0.045),
        "--surface-float": lighten(b, 0.6),
        "--line": darken(b, 0.13),
        "--line-soft": darken(b, 0.06),
        "--line-strong": darken(b, 0.22),
        "--ink": ink,
        "--ink-2": mixHex(ink, b, 0.42),
        "--ink-3": mixHex(ink, b, 0.62),
        "--social-bg": "rgba(0, 0, 0, 0.05)",
        "--scrollbar-thumb": darken(b, 0.2),
    };
}

// Everything the Custom theme sets, so the fixed themes can clear it.
export function customVarNames(): string[] {
    return [...Object.keys(deriveAccentVars(DEFAULT_ACCENT)), ...Object.keys(deriveSurfaceVars(DEFAULT_BG))];
}

export const ACCENT_PRESETS = ["#69a5c8", "#7c9c6a", "#c88a5a", "#b06a9c", "#c86a6a", "#8a86c8", "#5ab0a0", "#c8a84f"];
export const BG_PRESETS = ["#0c1016", "#101113", "#14100f", "#0e1512", "#161318", "#1b1b1f", "#f2ede3", "#eef1f4"];
