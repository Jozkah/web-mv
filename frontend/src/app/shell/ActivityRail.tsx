import { For, Show } from "solid-js";
import { Icon } from "../workspace/icons";
import { useShell } from "./ShellContext";
import { useApp } from "../AppContext";
import { useMemory } from "../../views/memory/state/MemoryContext";
import { CATEGORIES, type Category, type CategoryId } from "./categories";

// The activity rail: one item per category (Inspect / Search / Analyze / Modify / Organize).
// Selecting an item reveals that category's views in the contextual sidebar; the active item wears
// the 2px mint signal-trace. Each item carries an accessible name + tooltip and an optional live
// count badge. The whole strip is a single-focus roving tablist so the rail is fully keyboard
// operable (arrow keys move, Enter/Space activate).

export function ActivityRail() {
    const shell = useShell();
    const app = useApp();
    const memory = useMemory();

    const badge = (id: CategoryId): number | undefined => {
        if (id === "inspect") return memory.classes.length || undefined;
        if (id === "modify") return app.cheat.entries.length || undefined;
        if (id === "organize") return app.bookmarks.items.length || undefined;
        return undefined;
    };

    const isActive = (c: Category) => shell.category() === c.id && shell.sidebarOpen();

    const onKeyNav = (e: KeyboardEvent, index: number) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const next = (index + dir + CATEGORIES.length) % CATEGORIES.length;
        const el = document.querySelectorAll<HTMLElement>(".rail-item")[next];
        el?.focus();
    };

    return (
        <nav class="rail" aria-label="Activity">
            <div class="rail-items" role="tablist" aria-orientation="vertical">
                <For each={CATEGORIES}>
                    {(c, i) => (
                        <button
                            class="rail-item"
                            classList={{ active: isActive(c) }}
                            role="tab"
                            aria-selected={isActive(c)}
                            aria-label={c.label}
                            title={c.label}
                            tabindex={shell.category() === c.id ? 0 : -1}
                            onClick={() => shell.selectCategory(c.id)}
                            onKeyDown={(e) => onKeyNav(e, i())}
                        >
                            <span class="rail-trace" aria-hidden="true" />
                            <Icon name={c.icon} size={18} />
                            <Show when={badge(c.id) !== undefined}>
                                <span class="rail-badge">{badge(c.id)}</span>
                            </Show>
                            <span class="rail-label">{c.label}</span>
                        </button>
                    )}
                </For>
            </div>
            <div class="rail-foot">
                <button
                    class="rail-item"
                    classList={{ active: shell.zen() }}
                    aria-label="Focus mode"
                    aria-pressed={shell.zen()}
                    title="Focus mode — hide chrome (also in the command palette)"
                    tabindex={-1}
                    onClick={() => shell.toggleZen()}
                >
                    <Icon name="zen" size={17} />
                    <span class="rail-label">Focus</span>
                </button>
            </div>
        </nav>
    );
}
