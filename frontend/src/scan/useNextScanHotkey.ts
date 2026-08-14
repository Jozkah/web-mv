import { onCleanup, onMount } from "solid-js";

// Keyboard shortcut for "run the next scan/filter pass" (scan_filter), the action a value-
// scanner user repeats most: type a value, hit the hotkey, repeat. Default is Ctrl+Enter so it
// never collides with plain Enter inside a value input. Wire this into any scanner panel:
//
//   useNextScanHotkey(() => runFilterPass());
//
// Ignored while the trigger reports itself busy (e.g. a scan is already in flight) or while
// focus is in an unrelated text field that wants Ctrl+Enter for its own purpose - callers can
// pass `enabled: false` to suppress the hook entirely (e.g. when the scanner card is closed).
export interface NextScanHotkeyOptions {
    /** Held modifier required alongside `key`. Default requires Ctrl (or Cmd on macOS). */
    ctrlOrMeta?: boolean;
    /** Key to match, case-insensitive. Default "Enter". */
    key?: string;
    /** Set to false to detach the listener (e.g. panel not mounted/visible). Default true. */
    enabled?: () => boolean;
}

export function useNextScanHotkey(onTrigger: () => void, options: NextScanHotkeyOptions = {}): void {
    const requireMod = options.ctrlOrMeta ?? true;
    const targetKey = (options.key ?? "Enter").toLowerCase();
    const enabled = options.enabled ?? (() => true);

    function onKeyDown(e: KeyboardEvent): void {
        if (!enabled()) return;
        if (e.key.toLowerCase() !== targetKey) return;
        if (requireMod && !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        onTrigger();
    }

    onMount(() => window.addEventListener("keydown", onKeyDown));
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
}
