import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Tab } from "./Tab";
import { Icon } from "./icons";
import { NewTabMenu } from "./NewTabMenu";
import { TabOverflowMenu } from "./TabOverflowMenu";
import { TabContextMenu } from "./TabContextMenu";
import { defaultTabTitle, useWorkspace, type TabGroup, type TabItem, type TabKind } from "../WorkspaceContext";
import { useMemory } from "../../views/memory/state/MemoryContext";

const DRAG_THRESHOLD = 5;

// The tab strip for one group: a horizontally-scrollable row of tabs, an overflow dropdown, and
// the new-tab button. Owns tab interaction that needs cross-tab knowledge - drag-to-reorder,
// scroll/overflow state, and the popover menus.

export function TabBar(props: { group: TabGroup }) {
    const ws = useWorkspace();
    const memory = useMemory();

    let scrollEl: HTMLDivElement | undefined;
    // Tabs are read from the DOM (in visual order) rather than a captured ref list, so drag math
    // stays correct after a reorder.
    const tabEls = (): HTMLElement[] =>
        scrollEl ? Array.from(scrollEl.querySelectorAll<HTMLElement>(".ws-tab")) : [];

    const [newMenu, setNewMenu] = createSignal(false);
    const [overflowMenu, setOverflowMenu] = createSignal(false);
    const [ctxMenu, setCtxMenu] = createSignal<{ tabId: string; x: number; y: number } | null>(null);

    const [dragIndex, setDragIndex] = createSignal<number | null>(null);
    const [dropSlot, setDropSlot] = createSignal<number | null>(null);

    const [canLeft, setCanLeft] = createSignal(false);
    const [canRight, setCanRight] = createSignal(false);
    const [overflowing, setOverflowing] = createSignal(false);

    const displayTitle = (t: TabItem) => t.title || defaultTabTitle(t.kind);
    const tooltip = (t: TabItem) => {
        const title = displayTitle(t);
        const base = defaultTabTitle(t.kind);
        return title === base ? title : `${title}\n${base}`;
    };

    // ---- scroll / overflow state --------------------------------------------
    const updateScroll = () => {
        const el = scrollEl;
        if (!el) return;
        const max = el.scrollWidth - el.clientWidth;
        setOverflowing(max > 1);
        setCanLeft(el.scrollLeft > 1);
        setCanRight(el.scrollLeft < max - 1);
    };

    createEffect(() => {
        // Re-measure when the tab set changes.
        props.group.tabs.length;
        requestAnimationFrame(updateScroll);
    });

    createEffect(() => {
        if (!scrollEl) return;
        const ro = new ResizeObserver(() => updateScroll());
        ro.observe(scrollEl);
        onCleanup(() => ro.disconnect());
    });

    // Keep the active tab visible.
    createEffect(() => {
        const activeId = props.group.activeTabId;
        if (!activeId || !scrollEl) return;
        const idx = props.group.tabs.findIndex((t) => t.id === activeId);
        requestAnimationFrame(() => {
            const el = tabEls()[idx];
            const box = scrollEl;
            if (!el || !box) return;
            const left = el.offsetLeft;
            const right = left + el.offsetWidth;
            if (left < box.scrollLeft) box.scrollLeft = left - 8;
            else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth + 8;
        });
    });

    const onWheel = (e: WheelEvent) => {
        const el = scrollEl;
        if (!el || !overflowing()) return;
        const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (delta === 0) return;
        el.scrollLeft += delta;
        updateScroll();
        e.preventDefault();
    };

    // ---- drag to reorder ----------------------------------------------------
    const beginDrag = (index: number, e: PointerEvent) => {
        // Left button only; ignore clicks on the close button (it stops propagation itself).
        if (e.button !== 0) return;
        const startX = e.clientX;
        let active = false;

        const onMove = (ev: PointerEvent) => {
            if (!active && Math.abs(ev.clientX - startX) > DRAG_THRESHOLD) {
                active = true;
                setDragIndex(index);
            }
            if (!active) return;
            setDropSlot(computeSlot(ev.clientX));
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            const from = dragIndex();
            const slot = dropSlot();
            if (active && from !== null && slot !== null) {
                const to = slot > from ? slot - 1 : slot;
                if (to !== from) ws.moveTab(props.group.id, from, to);
            }
            setDragIndex(null);
            setDropSlot(null);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    // The insertion slot (0..n) for a pointer x-coordinate: count tabs whose horizontal midpoint
    // is left of the pointer.
    const computeSlot = (clientX: number): number => {
        const els = tabEls();
        let slot = els.length;
        for (let i = 0; i < els.length; i++) {
            const rect = els[i].getBoundingClientRect();
            if (clientX < rect.left + rect.width / 2) {
                slot = i;
                break;
            }
        }
        return slot;
    };

    // Pixel offset (within the scroll content) for the insertion indicator.
    const dropIndicatorLeft = (): number | null => {
        const slot = dropSlot();
        if (slot === null) return null;
        const els = tabEls();
        if (els.length === 0) return null;
        if (slot >= els.length) {
            const el = els[els.length - 1];
            return el.offsetLeft + el.offsetWidth;
        }
        return els[slot].offsetLeft;
    };

    // ---- new tab ------------------------------------------------------------
    const openView = (kind: TabKind) => {
        ws.focusGroup(props.group.id);
        if (kind === "memory") {
            ws.addTab("memory", { classId: memory.activeId ?? undefined, groupId: props.group.id });
        } else {
            ws.addTab(kind, { groupId: props.group.id });
        }
    };

    return (
        <header
            class="ws-tabbar"
            classList={{ "fade-left": canLeft(), "fade-right": canRight() }}
            onPointerDown={() => ws.focusGroup(props.group.id)}
        >
            <div
                ref={scrollEl}
                class="ws-tabs-scroll"
                role="tablist"
                aria-label="Open tabs"
                onWheel={onWheel}
                onScroll={updateScroll}
            >
                <Show when={dropIndicatorLeft() !== null}>
                    <div class="ws-drop-indicator" style={{ left: `${dropIndicatorLeft()}px` }} />
                </Show>
                <For each={props.group.tabs}>
                    {(tab, i) => (
                        <Tab
                            tab={tab}
                            title={displayTitle(tab)}
                            tooltip={tooltip(tab)}
                            active={tab.id === props.group.activeTabId}
                            dragging={dragIndex() === i()}
                            tabIndex={i()}
                            onSelect={() => ws.selectTab(tab.id)}
                            onClose={() => ws.closeTab(tab.id)}
                            onContextMenu={(e) => setCtxMenu({ tabId: tab.id, x: e.clientX, y: e.clientY })}
                            onPointerDown={(e) => beginDrag(i(), e)}
                        />
                    )}
                </For>
            </div>

            <div class="ws-tabbar-actions">
                <Show when={overflowing()}>
                    <div class="ws-action-wrap">
                        <button
                            class="ws-icon-btn"
                            aria-label="Show all open tabs"
                            title="All tabs"
                            onClick={(e) => {
                                e.stopPropagation();
                                setOverflowMenu((v) => !v);
                            }}
                        >
                            <Icon name="chevron-down" size={16} />
                        </button>
                        <Show when={overflowMenu()}>
                            <TabOverflowMenu
                                group={props.group}
                                onSelect={(id) => ws.selectTab(id)}
                                onClose={() => setOverflowMenu(false)}
                            />
                        </Show>
                    </div>
                </Show>

                <div class="ws-action-wrap">
                    <button
                        class="ws-icon-btn ws-new-tab"
                        aria-label="Open new tab"
                        title="New tab"
                        onClick={(e) => {
                            e.stopPropagation();
                            ws.focusGroup(props.group.id);
                            setNewMenu((v) => !v);
                        }}
                    >
                        <Icon name="plus" size={16} />
                    </button>
                    <Show when={newMenu()}>
                        <NewTabMenu onPick={openView} onClose={() => setNewMenu(false)} />
                    </Show>
                </div>
            </div>

            <Show when={ctxMenu()}>
                {(m) => (
                    <TabContextMenu
                        tabId={m().tabId}
                        x={m().x}
                        y={m().y}
                        onClose={() => setCtxMenu(null)}
                    />
                )}
            </Show>
        </header>
    );
}
