// Platform-aware keyboard-shortcut labels. "Mod" renders as ⌘ on macOS and Ctrl elsewhere, so the
// command palette and menus show the same combo the user actually presses.

export function isMac(): boolean {
    return typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

// Accepts a compact spec ("Mod+K", "Alt+←", "Mod+Shift+Z") and renders it for this platform.
export function shortcutLabel(spec: string): string {
    const mod = isMac() ? "⌘" : "Ctrl";
    return spec
        .replace(/Mod/g, mod)
        .replace(/Alt/g, isMac() ? "⌥" : "Alt")
        .replace(/Shift/g, isMac() ? "⇧" : "Shift")
        .replace(/\+/g, isMac() ? "" : "+");
}
