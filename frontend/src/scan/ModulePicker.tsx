import { For, Show, createMemo, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { onDismiss } from "../ui/dismiss";
import { useApp } from "../app/AppContext";
import { filterModules } from "../state/modulesStore";

// A styled, searchable module dropdown for the scan cards - a scan must target a module, so
// there is no "whole process" option. Replaces the bare <select> (which ignored the site
// theme) with a button + pop-over list that reuses the shared row/list vocabulary.
//
// The pop-over renders through a Portal and is positioned against the button: the scan card
// is `overflow: hidden`, so an in-flow absolute pop-over would be clipped to the card. The
// portal escapes that clip; we anchor it with the button's viewport rect. Closes on pick or
// on a mousedown outside both the button and the pop-over.

export function ModulePicker(props: { value: string; onChange: (name: string) => void }) {
    const { modules } = useApp();

    const [open, setOpen] = createSignal(false);
    const [query, setQuery] = createSignal("");
    const [rect, setRect] = createSignal<DOMRect | null>(null);

    let buttonEl: HTMLButtonElement | undefined;
    let popEl: HTMLDivElement | undefined;

    const filtered = createMemo(() => filterModules(modules.list(), query()));

    const toggle = () => {
        if (open()) {
            setOpen(false);
            return;
        }
        if (buttonEl) setRect(buttonEl.getBoundingClientRect());
        setQuery("");
        setOpen(true);
    };

    onDismiss({
        isOpen: open,
        inside: (target) => !!buttonEl?.contains(target) || !!popEl?.contains(target),
        close: () => setOpen(false),
        escape: false,
    });

    const choose = (name: string) => {
        props.onChange(name);
        setQuery("");
        setOpen(false);
    };

    return (
        <div class="module-picker">
            <button
                ref={buttonEl}
                class="module-picker-button"
                classList={{ placeholder: !props.value, open: open() }}
                onClick={toggle}
            >
                <span class="grow" title={props.value}>
                    {props.value || "select module"}
                </span>
                <span class="caret">▾</span>
            </button>

            <Show when={open() && rect()}>
                {(r) => (
                    <Portal>
                        <div
                            ref={popEl}
                            class="module-picker-pop panel"
                            style={{ top: `${r().bottom + 4}px`, left: `${r().left}px` }}
                        >
                            <input
                                class="search"
                                type="text"
                                placeholder="search module"
                                value={query()}
                                ref={(el) => queueMicrotask(() => el.focus())}
                                onInput={(e) => setQuery(e.currentTarget.value)}
                                onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
                            />
                            <div class="list module-options">
                                <For each={filtered()}>
                                    {(m) => (
                                        <div
                                            class="row"
                                            classList={{ selected: props.value === m.name }}
                                            onClick={() => choose(m.name)}
                                        >
                                            <span class="grow" title={m.name}>
                                                {m.name}
                                            </span>
                                            <span class="addr">{m.base}</span>
                                        </div>
                                    )}
                                </For>
                                <Show when={filtered().length === 0}>
                                    <p class="panel-status">
                                        {modules.list().length === 0
                                            ? "no modules found"
                                            : "no match"}
                                    </p>
                                </Show>
                            </div>
                        </div>
                    </Portal>
                )}
            </Show>
        </div>
    );
}
