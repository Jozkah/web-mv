import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { Icon } from "../workspace/icons";
import { useShell } from "./ShellContext";
import { useWorkspace, type TabKind } from "../WorkspaceContext";
import { useApp } from "../AppContext";
import { useNavigation, resolveGotoInput } from "../useNavigation";
import { useMemory } from "../../views/memory/state/MemoryContext";
import { useStatic } from "../../views/static/state/StaticContext";
import { useStrings } from "../../views/strings/state/StringsContext";
import { useSigMaker } from "../../views/static/sigmaker/SigMakerContext";
import { useSessionActions } from "./sessionActions";
import { parseQuery, hasQueryText } from "./search/query";
import { PROVIDERS, providersFor } from "./search/providers";
import { executeProviders, rankAll, groupResults, buildEmptyView, type RenderGroup } from "./search/engine";
import { rankSignals, recordRun, recordQuery, togglePin, isPinned, removeRecent } from "./search/history";
import type { PaletteStores } from "./search/stores";
import type { SearchAction, SearchContext, SearchMatch, SearchProviderState, SearchResult } from "./search/types";
import type { RankedResult } from "./search/ranking";

// The universal omnibox. This component is deliberately thin: it owns query state, selection, the
// action submenu and rendering. All searchable content lives in independent providers (search/
// providers), all scoring in search/ranking, all parsing in search/query. CommandPalette only wires
// the live stores into a SearchContext, runs the engine, and presents the result. Keyboard-first:
// ↑/↓ move, Enter runs the default action, Shift+Enter the primary alternate, Ctrl/⌘+Enter opens in
// a side split, Alt+Enter (or →) opens the action menu, Esc backs out one level at a time.

interface Section {
    title: string;
    items: RankedResult[];
}

function wrap(list: SearchResult[]): RankedResult[] {
    return list.map((result) => ({ result, score: 0, matches: [] }));
}

// Split a title into highlighted / plain runs from the ranking match ranges.
function titleRuns(title: string, matches: SearchMatch[] | undefined): { text: string; hit: boolean }[] {
    if (!matches || matches.length === 0) return [{ text: title, hit: false }];
    const runs: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (const m of matches) {
        if (m.start > at) runs.push({ text: title.slice(at, m.start), hit: false });
        runs.push({ text: title.slice(m.start, m.end), hit: true });
        at = m.end;
    }
    if (at < title.length) runs.push({ text: title.slice(at), hit: false });
    return runs;
}

export function CommandPalette() {
    const shell = useShell();
    const ws = useWorkspace();
    const app = useApp();
    const nav = useNavigation();
    const memory = useMemory();
    const staticCtx = useStatic();
    const strings = useStrings();
    const sigMaker = useSigMaker();
    const session = useSessionActions();

    const [query, setQuery] = createSignal("");
    const [cursor, setCursor] = createSignal(0);
    const [menuFor, setMenuFor] = createSignal<RankedResult | null>(null);
    const [menuCursor, setMenuCursor] = createSignal(0);
    const [syncResults, setSyncResults] = createSignal<SearchResult[]>([]);
    const [asyncResults, setAsyncResults] = createSignal<SearchResult[]>([]);
    const [providerStates, setProviderStates] = createSignal<SearchProviderState[]>([]);
    let inputRef: HTMLInputElement | undefined;
    let listRef: HTMLUListElement | undefined;

    onMount(() => inputRef?.focus());

    // The single seam between the search layer and the app's live stores.
    const stores: PaletteStores = { app, ws, shell, memory, staticCtx, strings, sigMaker, session };
    const ctx: SearchContext = {
        goto: (kind, address, label) => nav.goto(kind, address, label),
        resolveAddress: (text) => resolveGotoInput(text, app.modules.list()),
        moduleBase: (name) => app.modules.baseOf(name),
        copy: async (text) => {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                return false;
            }
        },
        openView: (kind) => ws.openOrFocusView(kind as TabKind),
        openSideSplit: (kind) => {
            const id = ws.addTab(kind as TabKind);
            ws.moveTabToSide(id);
        },
        debug: import.meta.env.DEV,
        stores: stores as unknown as SearchContext["stores"],
    };

    const parsed = createMemo(() => parseQuery(query()));

    const signals = () =>
        rankSignals({
            activeModule: staticCtx.selection.selectedModule() ?? undefined,
            activeView: app.activeView(),
            activeTarget: app.workspaceKey(),
        });

    // Provider execution. A generation token + AbortController guard the async path so a stale batch
    // never replaces newer results. Sync providers (the common case) resolve inside this effect and
    // render instantly; the effect re-runs whenever the query or any store a provider reads changes.
    let generation = 0;
    let controller: AbortController | null = null;
    createEffect(() => {
        const q = parsed();
        const routed = providersFor(q);
        const gen = ++generation;
        controller?.abort();
        const local = new AbortController();
        controller = local;
        setAsyncResults([]);
        if (!hasQueryText(q)) {
            setSyncResults([]);
            setProviderStates([]);
            return;
        }
        const run = executeProviders(q, ctx, routed, local.signal);
        setSyncResults(run.sync);
        setProviderStates(run.states);
        for (const pend of run.pending) {
            pend.promise
                .then((res) => {
                    if (local.signal.aborted || gen !== generation) return; // stale — drop
                    setAsyncResults((prev) => [...prev, ...res]);
                    setProviderStates((prev) => prev.map((p) => (p.id === pend.id ? { ...p, loading: false } : p)));
                })
                .catch((e) => {
                    if (gen !== generation) return;
                    setProviderStates((prev) => prev.map((p) => (p.id === pend.id ? { ...p, loading: false, error: String(e) } : p)));
                });
        }
    });

    const ranked = createMemo<RankedResult[]>(() => {
        const q = parsed();
        if (!hasQueryText(q)) return [];
        return rankAll(q, [...syncResults(), ...asyncResults()], signals());
    });

    const emptyView = createMemo(() => {
        const q = parsed();
        if (hasQueryText(q)) return null;
        return buildEmptyView(ctx, PROVIDERS, q, signals(), new AbortController().signal);
    });

    const sections = createMemo<Section[]>(() => {
        const ev = emptyView();
        if (ev) {
            const out: Section[] = [];
            if (ev.favorites.length) out.push({ title: "Favorites", items: wrap(ev.favorites) });
            if (ev.recent.length) out.push({ title: "Recent", items: wrap(ev.recent) });
            for (const g of ev.suggestions) out.push({ title: g.group, items: g.items });
            return out;
        }
        return groupResults(ranked()).map((g: RenderGroup) => ({ title: g.group, items: g.items }));
    });

    const flat = createMemo<RankedResult[]>(() => sections().flatMap((s) => s.items));

    // Keep the highlighted row valid as results change, and scroll it into view.
    createEffect(() => {
        const n = flat().length;
        if (cursor() >= n) setCursor(Math.max(0, n - 1));
    });
    createEffect(() => {
        const id = flat()[cursor()]?.result.id;
        if (!id || !listRef) return;
        const el = listRef.querySelector(`[data-rid="${CSS.escape(id)}"]`);
        el?.scrollIntoView({ block: "nearest" });
    });

    const providerErrors = createMemo(() => providerStates().filter((p) => p.error));
    const loadingProviders = createMemo(() => providerStates().filter((p) => p.loading));

    const runAction = (r: RankedResult, action: SearchAction) => {
        // Meta actions (pin, remove-from-recent) mutate personalization only — they neither navigate
        // nor close the palette.
        if (action.id.startsWith("meta:")) {
            void action.run(ctx);
            closeMenu();
            // Nudge the effect so any downstream ordering re-evaluates.
            setQuery((q) => q);
            return;
        }
        recordRun(r.result.id);
        recordQuery(query());
        shell.closePalette();
        void action.run(ctx);
    };

    // Enter on the current row. Destructive default actions are never fired here — they force the
    // action menu open so the user must pick them explicitly.
    const activate = (r: RankedResult | undefined, modifier: "default" | "alt" | "split") => {
        if (!r) return;
        const def = r.result.defaultAction;
        if (modifier === "default") {
            if (def.kind === "destructive") {
                openMenu(r);
                return;
            }
            runAction(r, def);
        } else if (modifier === "alt") {
            const first = r.result.altActions?.[0];
            if (first) runAction(r, first);
            else runAction(r, def);
        } else if (modifier === "split") {
            const split = [def, ...(r.result.altActions ?? [])].find((a) => a.kind === "split");
            if (split) runAction(r, split);
            else runAction(r, def);
        }
    };

    const openMenu = (r: RankedResult) => {
        setMenuFor(r);
        setMenuCursor(0);
    };
    const closeMenu = () => setMenuFor(null);
    const menuActions = (): SearchAction[] => {
        const r = menuFor();
        if (!r) return [];
        const id = r.result.id;
        const meta: SearchAction[] = [
            { id: "meta:pin", label: isPinned(id) ? "Unpin from favorites" : "Pin to favorites", icon: "organize", run: () => void togglePin(id) },
        ];
        if (signals().recent?.includes(id)) meta.push({ id: "meta:remove", label: "Remove from recent", icon: "close", run: () => removeRecent(id) });
        return [r.result.defaultAction, ...(r.result.altActions ?? []), ...meta];
    };

    const clearChip = (kind: "prefix" | "scope" | "group" | "neg", value?: string) => {
        let q = query();
        if (kind === "prefix") q = q.replace(/^\s*[>@#]\s*/, "");
        else if (kind === "scope") q = q.replace(new RegExp(`\\b${value}:`, "i"), "").trim();
        else if (kind === "group") q = q.replace(/\bgroup:\S+/i, "").trim();
        else if (kind === "neg" && value) q = q.replace(new RegExp(`(^|\\s)-${value}(?=\\s|$)`, "i"), " ").trim();
        setQuery(q);
        inputRef?.focus();
    };

    const onKeyDown = (e: KeyboardEvent) => {
        const mod = e.ctrlKey || e.metaKey;
        // Action menu owns the keys while open.
        if (menuFor()) {
            const acts = menuActions();
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setMenuCursor((c) => (c + 1) % acts.length);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setMenuCursor((c) => (c - 1 + acts.length) % acts.length);
            } else if (e.key === "Enter") {
                e.preventDefault();
                const r = menuFor()!;
                const act = acts[menuCursor()];
                if (act) runAction(r, act);
            } else if (e.key === "Escape" || e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
                e.preventDefault();
                closeMenu();
            }
            return;
        }

        const n = flat().length;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => (n === 0 ? 0 : (c + 1) % n));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => (n === 0 ? 0 : (c - 1 + n) % n));
        } else if (e.key === "PageDown") {
            e.preventDefault();
            setCursor((c) => Math.min(n - 1, c + 8));
        } else if (e.key === "PageUp") {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 8));
        } else if (e.key === "Home") {
            e.preventDefault();
            setCursor(0);
        } else if (e.key === "End") {
            e.preventDefault();
            setCursor(Math.max(0, n - 1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const r = flat()[cursor()];
            if (e.altKey) {
                if (r?.result.altActions?.length) openMenu(r);
            } else if (mod) activate(r, "split");
            else if (e.shiftKey) activate(r, "alt");
            else activate(r, "default");
        } else if ((e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) && flat()[cursor()]?.result.altActions?.length) {
            e.preventDefault();
            openMenu(flat()[cursor()]);
        } else if (mod && e.key === "Backspace") {
            e.preventDefault();
            setQuery("");
        } else if (e.key === "Escape") {
            e.preventDefault();
            if (query()) setQuery("");
            else shell.closePalette();
        }
    };

    // Alt+Enter handled here because some browsers fold it oddly into the Enter branch above.
    const onKeyUp = () => {};

    const chips = createMemo(() => {
        const q = parsed();
        const out: { kind: "prefix" | "scope" | "group" | "neg"; label: string; value?: string }[] = [];
        if (q.prefix) out.push({ kind: "prefix", label: q.prefix === ">" ? "commands" : q.prefix === "@" ? "modules" : "symbols" });
        if (q.scope) out.push({ kind: "scope", label: `${q.scope}:`, value: q.scope });
        if (q.groupFilter) out.push({ kind: "group", label: `group: ${q.groupFilter}` });
        for (const nq of q.negatives) out.push({ kind: "neg", label: `−${nq}`, value: nq });
        return out;
    });

    const selected = createMemo(() => flat()[cursor()]?.result);

    return (
        <div class="palette-overlay" onPointerDown={() => shell.closePalette()}>
            <div
                class="palette palette--wide"
                onPointerDown={(e) => e.stopPropagation()}
                role="dialog"
                aria-label="Universal search"
            >
                <div class="palette-input-row">
                    <Icon name="command" size={16} />
                    <input
                        ref={inputRef}
                        class="palette-input"
                        type="text"
                        role="combobox"
                        aria-expanded={true}
                        aria-controls="palette-listbox"
                        aria-activedescendant={selected() ? `opt-${selected()!.id}` : undefined}
                        spellcheck={false}
                        autocomplete="off"
                        placeholder="Search everything — commands, modules, functions, addresses, bookmarks…"
                        value={query()}
                        onInput={(e) => {
                            setQuery(e.currentTarget.value);
                            setCursor(0);
                        }}
                        onKeyDown={onKeyDown}
                        onKeyUp={onKeyUp}
                    />
                    <Show when={query()}>
                        <button class="palette-clear" aria-label="Clear query" onClick={() => { setQuery(""); inputRef?.focus(); }}>
                            <Icon name="close" size={14} />
                        </button>
                    </Show>
                    <span class="palette-esc">esc</span>
                </div>

                <Show when={chips().length > 0 || parsed().error}>
                    <div class="palette-chips">
                        <For each={chips()}>
                            {(c) => (
                                <button class="palette-chip" onClick={() => clearChip(c.kind, c.value)} title="Remove filter">
                                    {c.label}
                                    <Icon name="close" size={11} />
                                </button>
                            )}
                        </For>
                        <Show when={parsed().error}>
                            <span class="palette-chip palette-chip--error">{parsed().error}</span>
                        </Show>
                    </div>
                </Show>

                <div class="palette-body">
                    <div class="palette-main">
                        <Show
                            when={flat().length > 0}
                            fallback={
                                <div class="palette-empty">
                                    <Show
                                        when={hasQueryText(parsed())}
                                        fallback={<EmptyHints />}
                                    >
                                        No matches. Try a view name, a module, an address like <code>0x1400+0x28</code>, or a scope like <code>module:</code>.
                                    </Show>
                                </div>
                            }
                        >
                            <ul class="palette-list" id="palette-listbox" role="listbox" ref={listRef}>
                                <For each={sections()}>
                                    {(section) => (
                                        <li role="group" aria-label={section.title} class="palette-group">
                                            <div class="palette-group-head">
                                                <span>{section.title}</span>
                                                <span class="palette-group-count">{section.items.length}</span>
                                            </div>
                                            <ul class="palette-group-list" role="presentation">
                                                <For each={section.items}>
                                                    {(item) => {
                                                        const idx = () => flat().findIndex((f) => f.result.id === item.result.id);
                                                        return (
                                                            <li
                                                                id={`opt-${item.result.id}`}
                                                                data-rid={item.result.id}
                                                                class="palette-item"
                                                                classList={{ active: idx() === cursor(), disabled: !!item.result.disabled }}
                                                                role="option"
                                                                aria-selected={idx() === cursor()}
                                                                aria-disabled={!!item.result.disabled}
                                                                onPointerEnter={() => setCursor(idx())}
                                                                onClick={() => activate(item, "default")}
                                                            >
                                                                <span class="palette-item-icon">
                                                                    <Show when={item.result.icon}>
                                                                        <Icon name={item.result.icon as never} size={15} />
                                                                    </Show>
                                                                </span>
                                                                <span class="palette-item-body">
                                                                    <span class="palette-item-title">
                                                                        <For each={titleRuns(item.result.title, item.matches)}>
                                                                            {(run) => (run.hit ? <mark>{run.text}</mark> : <>{run.text}</>)}
                                                                        </For>
                                                                        <For each={item.result.badges ?? []}>
                                                                            {(b) => <span class="palette-badge" data-kind={b.kind}>{b.label}</span>}
                                                                        </For>
                                                                    </span>
                                                                    <Show when={item.result.subtitle || item.result.hint}>
                                                                        <span class="palette-item-hint">{item.result.subtitle ?? item.result.hint}</span>
                                                                    </Show>
                                                                    <Show when={item.result.disabled}>
                                                                        <span class="palette-item-reason">{item.result.disabled!.reason}</span>
                                                                    </Show>
                                                                </span>
                                                                <Show when={item.result.kbd}>
                                                                    <span class="palette-item-kbd">{item.result.kbd}</span>
                                                                </Show>
                                                                <Show when={item.result.altActions?.length}>
                                                                    <button
                                                                        class="palette-item-more"
                                                                        aria-label="Result actions"
                                                                        onClick={(e) => { e.stopPropagation(); setCursor(idx()); openMenu(item); }}
                                                                    >
                                                                        <Icon name="more" size={14} />
                                                                    </button>
                                                                </Show>
                                                            </li>
                                                        );
                                                    }}
                                                </For>
                                            </ul>
                                        </li>
                                    )}
                                </For>
                            </ul>
                        </Show>

                        <Show when={providerErrors().length > 0}>
                            <div class="palette-provider-errors">
                                <For each={providerErrors()}>
                                    {(p) => <div class="palette-provider-error"><Icon name="target" size={12} /> {p.id}: {p.error}</div>}
                                </For>
                            </div>
                        </Show>
                    </div>

                    <Show when={selected()?.preview}>
                        <PreviewPane result={selected()!} />
                    </Show>
                </div>

                <div class="palette-footer">
                    <span class="palette-count">
                        {flat().length} result{flat().length === 1 ? "" : "s"}
                        <Show when={loadingProviders().length > 0}><span class="palette-loading"> · loading…</span></Show>
                    </span>
                    <span class="palette-hints">
                        <kbd>↑↓</kbd> move · <kbd>↵</kbd> run · <kbd>⇧↵</kbd> alt · <kbd>⌥↵</kbd> actions
                    </span>
                </div>

                <div class="sr-only" role="status" aria-live="polite">
                    {flat().length} results{loadingProviders().length ? ", loading" : ""}
                </div>

                <Show when={menuFor()}>
                    <ActionMenu
                        result={menuFor()!}
                        cursor={menuCursor()}
                        actions={menuActions()}
                        onHover={setMenuCursor}
                        onRun={(a) => runAction(menuFor()!, a)}
                        onClose={closeMenu}
                    />
                </Show>
            </div>
        </div>
    );
}

function EmptyHints() {
    return (
        <div class="palette-hints-empty">
            <p>Start typing to search everything. Examples:</p>
            <ul>
                <li><code>@ client</code> — find a module</li>
                <li><code>&gt; split</code> — run a command</li>
                <li><code>0x1400+0x28</code> — go to an address</li>
                <li><code>bookmark:player</code> — scoped search</li>
            </ul>
        </div>
    );
}

function PreviewPane(props: { result: SearchResult }) {
    const [data, setData] = createSignal<{ title: string; rows: { label: string; value: string }[]; body?: string }>();
    createEffect(() => {
        const r = props.result;
        const ac = new AbortController();
        setData(undefined);
        if (!r.preview) return;
        Promise.resolve(r.preview(ac.signal))
            .then((d) => {
                if (!ac.signal.aborted) setData(d);
            })
            .catch(() => {});
        return () => ac.abort();
    });
    return (
        <Show when={data()}>
            <aside class="palette-preview" aria-label="Preview">
                <div class="palette-preview-title">{data()!.title}</div>
                <dl class="palette-preview-rows">
                    <For each={data()!.rows}>
                        {(row) => (
                            <>
                                <dt>{row.label}</dt>
                                <dd>{row.value}</dd>
                            </>
                        )}
                    </For>
                </dl>
                <Show when={data()!.body}>
                    <div class="palette-preview-body">{data()!.body}</div>
                </Show>
            </aside>
        </Show>
    );
}

function ActionMenu(props: {
    result: RankedResult;
    cursor: number;
    actions: SearchAction[];
    onHover: (i: number) => void;
    onRun: (a: SearchAction) => void;
    onClose: () => void;
}) {
    return (
        <div class="palette-actionmenu-overlay" onPointerDown={props.onClose}>
            <div class="palette-actionmenu" onPointerDown={(e) => e.stopPropagation()} role="menu" aria-label={`Actions for ${props.result.result.title}`}>
                <div class="palette-actionmenu-head">{props.result.result.title}</div>
                <For each={props.actions}>
                    {(a, i) => (
                        <button
                            class="palette-actionmenu-item"
                            classList={{ active: i() === props.cursor, destructive: a.kind === "destructive" }}
                            role="menuitem"
                            onPointerEnter={() => props.onHover(i())}
                            onClick={() => props.onRun(a)}
                        >
                            <Show when={a.icon}>
                                <Icon name={a.icon as never} size={14} />
                            </Show>
                            <span>{a.label}</span>
                        </button>
                    )}
                </For>
            </div>
        </div>
    );
}
