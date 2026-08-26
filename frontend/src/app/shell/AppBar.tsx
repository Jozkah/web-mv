import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "../workspace/icons";
import { useShell, THEMES, type ThemeId } from "./ShellContext";
import { ACCENT_PRESETS, BG_PRESETS, normalizeHex } from "./accent";
import { useApp } from "../AppContext";
import { useWorkspace } from "../WorkspaceContext";
import { useNavigation } from "../useNavigation";
import { useSigMaker } from "../../views/static/sigmaker/SigMakerContext";
import { useSessionActions } from "./sessionActions";
import { useDismiss } from "../workspace/useDismiss";
import { targetLabel, NO_TARGET_KEY } from "../../state/workspaceKey";
import { TargetMenu } from "./TargetMenu";
import { isMac, shortcutLabel } from "./shortcuts";

// The 44px application bar. Left: identity + active workspace name + jump history. Centre: the
// universal command / address field (click or Ctrl/Cmd+K for command mode, Ctrl/Cmd+G for address
// mode). Right: the compact target switcher plus the Session and More menus. This component also
// registers the global chrome shortcuts (palette, goto, back/forward) once for the whole app.

export function AppBar() {
    const shell = useShell();
    const app = useApp();
    const ws = useWorkspace();
    const nav = useNavigation();
    const sigMaker = useSigMaker();
    const session = useSessionActions();

    const workspaceName = () => {
        if (app.isFollowingLive()) {
            return app.liveKey() !== NO_TARGET_KEY
                ? targetLabel({ key: app.liveKey(), pid: app.pid(), base: app.base(), lastSeen: 0 })
                : "No target attached";
        }
        const t = app.targets().find((t) => t.key === app.workspaceKey());
        return t ? `${targetLabel(t)} (saved)` : "Saved workspace";
    };

    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            const k = e.key.toLowerCase();
            if (mod && k === "k") {
                e.preventDefault();
                shell.openPalette();
            } else if (mod && k === "p" && !e.shiftKey) {
                // Ctrl/Cmd+P opens the universal search (file/symbol-oriented). Overrides the browser
                // print dialog inside the app, matching VS Code's quick-open convention.
                e.preventDefault();
                shell.openPalette();
            } else if (mod && k === "g") {
                e.preventDefault();
                shell.openGoto();
            } else if (e.altKey && e.key === "ArrowLeft") {
                e.preventDefault();
                nav.back();
            } else if (e.altKey && e.key === "ArrowRight") {
                e.preventDefault();
                nav.forward();
            }
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    return (
        <header class="appbar">
            <div class="appbar-left">
                <div class="brand" title="web-mv — Signal Workbench">
                    <span class="brand-mark" aria-hidden="true" />
                    <span class="brand-name">web-mv</span>
                </div>
                <div class="appbar-workspace" title="Active workspace">
                    {workspaceName()}
                </div>
                <div class="appbar-nav">
                    <button
                        class="icon-btn"
                        aria-label="Back"
                        title={`Back (${shortcutLabel("Alt+←")})`}
                        disabled={!nav.canBack()}
                        onClick={() => nav.back()}
                    >
                        <Icon name="back" size={16} />
                    </button>
                    <button
                        class="icon-btn"
                        aria-label="Forward"
                        title={`Forward (${shortcutLabel("Alt+→")})`}
                        disabled={!nav.canForward()}
                        onClick={() => nav.forward()}
                    >
                        <Icon name="forward" size={16} />
                    </button>
                </div>
            </div>

            <button class="command-field" onClick={() => shell.openPalette()} title="Universal search — commands, modules, functions, addresses">
                <Icon name="command" size={15} />
                <span class="command-field-text">Search everything — commands, modules, addresses…</span>
                <span class="command-field-kbd">{isMac() ? "⌘K" : "Ctrl K"}</span>
            </button>

            <div class="appbar-right">
                <TargetMenu />
                <SessionMenu onSave={session.save} onLoad={session.load} />
                <MoreMenu
                    onSigMaker={() => sigMaker.open({})}
                    onSigScan={() => shell.toggleSigScan()}
                    sigScanOpen={shell.sigScanOpen()}
                    onSplit={() => {
                        const id = ws.activeTab()?.id;
                        if (id) ws.moveTabToSide(id);
                    }}
                    onGoto={() => shell.openGoto()}
                    onZen={() => shell.toggleZen()}
                    zen={shell.zen()}
                    theme={shell.theme()}
                    onSetTheme={(t) => shell.setTheme(t)}
                    accent={shell.accent()}
                    onSetAccent={(hex) => shell.setAccent(hex)}
                    defaultAccent={shell.defaultAccent}
                    background={shell.background()}
                    onSetBackground={(hex) => shell.setBackground(hex)}
                    defaultBackground={shell.defaultBackground}
                />
            </div>
        </header>
    );
}

function SessionMenu(props: { onSave: () => void; onLoad: () => void }) {
    const [open, setOpen] = createSignal(false);
    let root: HTMLDivElement | undefined;
    useDismiss(() => root, () => setOpen(false), open);
    const run = (fn: () => void) => {
        fn();
        setOpen(false);
    };
    return (
        <div class="appbar-menu" ref={root}>
            <button
                class="appbar-menu-btn"
                classList={{ open: open() }}
                aria-haspopup="menu"
                aria-expanded={open()}
                onClick={() => setOpen((v) => !v)}
                title="Session"
            >
                <Icon name="session" size={15} />
                <span>Session</span>
                <Icon name="chevron-down" size={12} />
            </button>
            <Show when={open()}>
                <div class="menu-pop" role="menu">
                    <button class="menu-pop-item" role="menuitem" onClick={() => run(props.onSave)}>
                        <Icon name="export" size={15} />
                        <span>Save Session…</span>
                    </button>
                    <button class="menu-pop-item" role="menuitem" onClick={() => run(props.onLoad)}>
                        <Icon name="session" size={15} />
                        <span>Load Session…</span>
                    </button>
                    <p class="menu-pop-note">Bundles classes, cheats and bookmarks to a JSON file.</p>
                </div>
            </Show>
        </div>
    );
}

function MoreMenu(props: {
    onSigMaker: () => void;
    onSigScan: () => void;
    sigScanOpen: boolean;
    onSplit: () => void;
    onGoto: () => void;
    onZen: () => void;
    zen: boolean;
    theme: ThemeId;
    onSetTheme: (t: ThemeId) => void;
    accent: string;
    onSetAccent: (hex: string) => void;
    defaultAccent: string;
    background: string;
    onSetBackground: (hex: string) => void;
    defaultBackground: string;
}) {
    const [open, setOpen] = createSignal(false);
    let root: HTMLDivElement | undefined;
    useDismiss(() => root, () => setOpen(false), open);
    const run = (fn: () => void) => {
        fn();
        setOpen(false);
    };
    return (
        <div class="appbar-menu" ref={root}>
            <button
                class="icon-btn"
                classList={{ open: open() }}
                aria-haspopup="menu"
                aria-expanded={open()}
                aria-label="More actions"
                title="More"
                onClick={() => setOpen((v) => !v)}
            >
                <Icon name="more" size={16} />
            </button>
            <Show when={open()}>
                <div class="menu-pop menu-pop--right" role="menu">
                    <button class="menu-pop-item" role="menuitem" onClick={() => run(props.onSigScan)}>
                        <Icon name="sigscan" size={15} />
                        <span>Signature Scan window</span>
                        <Show when={props.sigScanOpen}><span class="menu-pop-flag">open</span></Show>
                    </button>
                    <button class="menu-pop-item" role="menuitem" onClick={() => run(props.onSigMaker)}>
                        <Icon name="static" size={15} />
                        <span>SigMaker…</span>
                    </button>
                    <button class="menu-pop-item" role="menuitem" onClick={() => run(props.onGoto)}>
                        <Icon name="target" size={15} />
                        <span>Go to address…</span>
                        <span class="menu-pop-kbd">{shortcutLabel("Mod+G")}</span>
                    </button>
                    <div class="menu-pop-sep" />
                    <button class="menu-pop-item" role="menuitem" onClick={() => run(props.onSplit)}>
                        <Icon name="split" size={15} />
                        <span>Split active tab to side</span>
                    </button>
                    <button class="menu-pop-item" role="menuitemcheckbox" aria-checked={props.zen} onClick={() => run(props.onZen)}>
                        <Icon name="zen" size={15} />
                        <span>Focus mode</span>
                        <Show when={props.zen}><span class="menu-pop-flag">on</span></Show>
                    </button>
                    <div class="menu-pop-sep" />
                    <div class="menu-pop-head">Theme</div>
                    <div class="theme-seg" role="radiogroup" aria-label="Theme">
                        <For each={THEMES}>
                            {(t) => (
                                <button
                                    class="theme-seg-btn"
                                    classList={{ active: props.theme === t.id }}
                                    role="radio"
                                    aria-checked={props.theme === t.id}
                                    title={t.hint}
                                    onClick={() => props.onSetTheme(t.id)}
                                >
                                    <Show when={t.id === "custom"}>
                                        <span class="theme-seg-swatch" style={{ background: props.accent }} aria-hidden="true" />
                                    </Show>
                                    {t.label}
                                </button>
                            )}
                        </For>
                    </div>

                    <Show when={props.theme === "custom"}>
                        <div class="accent-picker">
                            <ColorControl
                                label="Accent"
                                value={props.accent}
                                presets={ACCENT_PRESETS}
                                defaultValue={props.defaultAccent}
                                onSet={props.onSetAccent}
                            />
                            <ColorControl
                                label="Background"
                                value={props.background}
                                presets={BG_PRESETS}
                                defaultValue={props.defaultBackground}
                                onSet={props.onSetBackground}
                            />
                        </div>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

// One labelled colour control: a native swatch, an editable hex field, a reset, and preset dots.
// `draft` holds the text field; a valid hex commits up via onSet. External changes (swatch, presets,
// reset) update the draft directly, so the field stays in sync without an effect loop.
function ColorControl(props: {
    label: string;
    value: string;
    presets: string[];
    defaultValue: string;
    onSet: (hex: string) => void;
}) {
    const [draft, setDraft] = createSignal(props.value);
    const apply = (hex: string) => {
        setDraft(hex);
        props.onSet(hex);
    };
    return (
        <div class="color-control">
            <div class="color-control-label">{props.label}</div>
            <div class="accent-row">
                <input
                    class="accent-swatch"
                    type="color"
                    aria-label={`${props.label} colour`}
                    value={props.value}
                    onInput={(e) => apply(e.currentTarget.value)}
                />
                <input
                    class="accent-hex"
                    type="text"
                    spellcheck={false}
                    autocomplete="off"
                    aria-label={`${props.label} hex`}
                    value={draft()}
                    onInput={(e) => {
                        setDraft(e.currentTarget.value);
                        const n = normalizeHex(e.currentTarget.value);
                        if (n) props.onSet(n);
                    }}
                />
                <button class="accent-reset" title={`Reset ${props.label.toLowerCase()}`} onClick={() => apply(props.defaultValue)}>
                    Reset
                </button>
            </div>
            <div class="accent-presets">
                <For each={props.presets}>
                    {(hex) => (
                        <button
                            class="accent-preset"
                            classList={{ active: normalizeHex(props.value) === hex }}
                            style={{ background: hex }}
                            aria-label={`${props.label} ${hex}`}
                            title={hex}
                            onClick={() => apply(hex)}
                        />
                    )}
                </For>
            </div>
        </div>
    );
}
