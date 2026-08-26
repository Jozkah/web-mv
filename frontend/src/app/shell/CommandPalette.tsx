import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { Icon } from "../workspace/icons";
import { useShell } from "./ShellContext";
import { useWorkspace, type TabKind } from "../WorkspaceContext";
import { useApp } from "../AppContext";
import { useNavigation } from "../useNavigation";
import { useSigMaker } from "../../views/static/sigmaker/SigMakerContext";
import { useSessionActions } from "./sessionActions";
import { CATEGORIES } from "./categories";
import { THEMES } from "./ShellContext";
import { targetLabel } from "../../state/workspaceKey";
import { shortcutLabel } from "./shortcuts";
import { rankCommands, loadRecent, recordRecent, type Command } from "./commands";

// The command palette (Ctrl/Cmd+K). Fuzzy-searchable access to every view and global action, with
// recent commands and recent addresses when the query is empty. Fully keyboard driven: type to
// filter, ↑/↓ to move, Enter to run, Esc to close. Shortcut hints render per platform.

export function CommandPalette() {
    const shell = useShell();
    const ws = useWorkspace();
    const app = useApp();
    const nav = useNavigation();
    const sigMaker = useSigMaker();
    const session = useSessionActions();

    const [query, setQuery] = createSignal("");
    const [cursor, setCursor] = createSignal(0);
    const [recent, setRecent] = createSignal<string[]>(loadRecent());
    let inputRef: HTMLInputElement | undefined;

    onMount(() => inputRef?.focus());

    const activeTabId = () => ws.activeTab()?.id;

    // Build the full command set fresh each read so it reflects current tabs/targets/history.
    const allCommands = (): Command[] => {
        const cmds: Command[] = [];

        // Views — every view, grouped under its category for keyword matching.
        for (const cat of CATEGORIES) {
            for (const v of cat.views) {
                const kind = v.kind as TabKind;
                cmds.push({
                    id: `view:${kind}`,
                    title: `Open ${v.label}`,
                    group: "Views",
                    icon: kind === "sigscan" ? "sigscan" : kind,
                    hint: v.hint,
                    keywords: `${cat.label} ${v.label} ${v.hint}`,
                    run: () => {
                        if (kind === "sigscan") shell.setSigScanOpen(true);
                        else ws.openOrFocusView(kind);
                    },
                });
            }
        }

        const act = (id: string, title: string, opts: Partial<Command> & { run: () => void }): Command => ({
            id,
            title,
            group: "Actions",
            ...opts,
        });

        cmds.push(
            act("action:goto", "Go to address", { icon: "target", kbd: shortcutLabel("Mod+G"), keywords: "goto jump address navigate", run: () => shell.openGoto() }),
            act("action:sigscan", "Signature Scan window", { icon: "sigscan", keywords: "pattern ida scan", run: () => shell.setSigScanOpen(true) }),
            act("action:sigmaker", "SigMaker", { icon: "static", keywords: "signature generate ida create", run: () => sigMaker.open({}) }),
            act("action:save", "Save Session", { icon: "export", keywords: "download export json classes cheats bookmarks", run: () => session.save() }),
            act("action:load", "Load Session", { icon: "session", keywords: "import upload json merge", run: () => session.load() }),
            act("action:split", "Split active tab to side", { icon: "split", keywords: "split group side", run: () => { const id = activeTabId(); if (id) ws.moveTabToSide(id); } }),
            act("action:close", "Close active tab", { icon: "close", kbd: shortcutLabel("Mod+W"), keywords: "close tab", run: () => { const id = activeTabId(); if (id) ws.closeTab(id); } }),
            act("action:dup", "Duplicate active tab", { icon: "plus", keywords: "duplicate copy tab", run: () => { const id = activeTabId(); if (id) ws.duplicateTab(id); } }),
            act("action:sidebar", "Toggle sidebar", { icon: "sidebar", keywords: "sidebar panel collapse expand", run: () => shell.toggleSidebar() }),
            act("action:zen", "Toggle focus mode", { icon: "zen", keywords: "zen focus distraction chrome", run: () => shell.toggleZen() }),
            act("action:follow", "Attach — Follow Live target", { icon: "target", keywords: "attach follow live process target", run: () => app.followLive() }),
        );
        if (ws.canReopen()) {
            cmds.push(act("action:reopen", "Reopen closed tab", { icon: "plus", keywords: "reopen restore closed tab", run: () => ws.reopenClosedTab() }));
        }

        // Themes.
        for (const t of THEMES) {
            cmds.push(act(`theme:${t.id}`, `Theme: ${t.label}`, {
                icon: "theme",
                hint: t.hint,
                keywords: `theme appearance colour color light dark ${t.label}`,
                run: () => shell.setTheme(t.id),
            }));
        }

        // Targets — jump to a saved workspace.
        for (const t of app.targets()) {
            cmds.push({
                id: `target:${t.key}`,
                title: `Switch to ${targetLabel(t)}`,
                group: "Targets",
                icon: "target",
                keywords: `target workspace ${t.pid ?? ""} ${t.base ?? ""}`,
                run: () => app.selectTarget(t.key),
            });
        }

        // Recent addresses — from the jump history, newest first, unique by address.
        const seen = new Set<string>();
        for (let i = app.nav.entries.length - 1; i >= 0 && seen.size < 8; i--) {
            const e = app.nav.entries[i];
            if (seen.has(e.address)) continue;
            seen.add(e.address);
            cmds.push({
                id: `addr:${e.address}`,
                title: `Go to ${e.label ?? e.address}`,
                group: "Recent",
                icon: e.kind === "memory" ? "memory" : "static",
                hint: e.address,
                keywords: `address ${e.address} ${e.label ?? ""}`,
                run: () => nav.goto(e.kind, e.address, e.label),
            });
        }

        return cmds;
    };

    // Results: ranked when the user typed a query, otherwise recent commands + a curated default.
    const results = createMemo<Command[]>(() => {
        const q = query().trim();
        const all = allCommands();
        if (q) return rankCommands(q, all).slice(0, 40).map((r) => r.cmd);

        const byId = new Map(all.map((c) => [c.id, c]));
        const recents = recent().map((id) => byId.get(id)).filter((c): c is Command => !!c);
        const recentIds = new Set(recents.map((c) => c.id));
        const addrs = all.filter((c) => c.group === "Recent");
        const views = all.filter((c) => c.group === "Views" && !recentIds.has(c.id)).slice(0, 6);
        return [...recents, ...addrs.filter((c) => !recentIds.has(c.id)), ...views];
    });

    // Keep the highlighted row valid as the result set shrinks/grows.
    createEffect(() => {
        const n = results().length;
        if (cursor() >= n) setCursor(Math.max(0, n - 1));
    });

    const run = (cmd: Command) => {
        setRecent(recordRecent(cmd.id));
        shell.closePalette();
        cmd.run();
    };

    const onKeyDown = (e: KeyboardEvent) => {
        const n = results().length;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => (n === 0 ? 0 : (c + 1) % n));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => (n === 0 ? 0 : (c - 1 + n) % n));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const cmd = results()[cursor()];
            if (cmd) run(cmd);
        } else if (e.key === "Escape") {
            e.preventDefault();
            shell.closePalette();
        }
    };

    return (
        <div class="palette-overlay" onPointerDown={() => shell.closePalette()}>
            <div class="palette" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
                <div class="palette-input-row">
                    <Icon name="command" size={16} />
                    <input
                        ref={inputRef}
                        class="palette-input"
                        type="text"
                        spellcheck={false}
                        autocomplete="off"
                        placeholder="Search commands, views and recent addresses…"
                        value={query()}
                        onInput={(e) => {
                            setQuery(e.currentTarget.value);
                            setCursor(0);
                        }}
                        onKeyDown={onKeyDown}
                    />
                    <span class="palette-esc">esc</span>
                </div>

                <Show
                    when={results().length > 0}
                    fallback={<div class="palette-empty">No matching command. Try a view name, “goto”, “session”, or an address.</div>}
                >
                    <ul class="palette-list" role="listbox">
                        <For each={results()}>
                            {(cmd, i) => (
                                <li
                                    class="palette-item"
                                    classList={{ active: i() === cursor() }}
                                    role="option"
                                    aria-selected={i() === cursor()}
                                    onPointerEnter={() => setCursor(i())}
                                    onClick={() => run(cmd)}
                                >
                                    <span class="palette-item-icon">
                                        <Show when={cmd.icon}>
                                            <Icon name={cmd.icon as never} size={15} />
                                        </Show>
                                    </span>
                                    <span class="palette-item-body">
                                        <span class="palette-item-title">{cmd.title}</span>
                                        <Show when={cmd.hint}>
                                            <span class="palette-item-hint">{cmd.hint}</span>
                                        </Show>
                                    </span>
                                    <span class="palette-item-group">{cmd.group}</span>
                                    <Show when={cmd.kbd}>
                                        <span class="palette-item-kbd">{cmd.kbd}</span>
                                    </Show>
                                </li>
                            )}
                        </For>
                    </ul>
                </Show>
            </div>
        </div>
    );
}
