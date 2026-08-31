import { For, Show, createMemo, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { onDismiss } from "../ui/dismiss";
import { useApp } from "../app/AppContext";
import { filterModules } from "../state/modulesStore";

// A styled, searchable module dropdown. Replaces bare <select> module lists (which ignored the
// site theme and had no search) with a button + pop-over list that reuses the shared row/list
// vocabulary. Used both by the scan cards (which require a module) and by toolbars that also
// offer a "none" choice - pass `emptyLabel` to render a first row with value "" (e.g. whole
// process / main module).
//
// The pop-over renders through a Portal and is positioned against the button: hosts are often
// `overflow: hidden`, so an in-flow absolute pop-over would be clipped. The portal escapes that
// clip; we anchor it with the button's viewport rect. Closes on pick or on a mousedown outside
// both the button and the pop-over.

export function ModulePicker(props: {
    value: string;
    onChange: (name: string) => void;
    emptyLabel?: string;
    class?: string;
    disabled?: boolean;
}) {
    const { modules } = useApp();

    const [open, setOpen] = createSignal(false);
    const [query, setQuery] = createSignal("");
    const [rect, setRect] = createSignal<DOMRect | null>(null);

    let buttonEl: HTMLButtonElement | undefined;
    let popEl: HTMLDivElement | undefined;

    const filtered = createMemo(() => filterModules(modules.list(), query()));
    // The empty/"none" row only makes sense when the caller offers one, and only when it isn't
    // being filtered out by a query.
    const showEmpty = createMemo(() => !!props.emptyLabel && query().trim().length === 0);

    const buttonText = () => props.value || props.emptyLabel || "select module";

    const toggle = () => {
        if (props.disabled) return;
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
                class={`module-picker-button${props.class ? ` ${props.class}` : ""}`}
                classList={{ placeholder: !props.value && !props.emptyLabel, open: open() }}
                disabled={props.disabled}
                onClick={toggle}
            >
                <span class="grow" title={buttonText()}>
                    {buttonText()}
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
                                <Show when={showEmpty()}>
                                    <div
                                        class="row"
                                        classList={{ selected: props.value === "" }}
                                        onClick={() => choose("")}
                                    >
                                        <span class="grow">{props.emptyLabel}</span>
                                    </div>
                                </Show>
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
                                <Show when={filtered().length === 0 && !showEmpty()}>
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
