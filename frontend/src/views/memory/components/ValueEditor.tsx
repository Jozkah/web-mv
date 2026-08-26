import { Show, createSignal } from "solid-js";

// Inline typed-value editor for the grid's Value column. Dumb by design: the parent supplies
// live validation (pure encode check) and the async commit; this renders the input with its
// pending/error affordances. Enter commits (blocked while a write is pending or input invalid),
// Escape cancels. Blur cancels rather than committing - a process write is too consequential
// to fire from a stray click.

export function ValueEditor(props: {
    initial: string;
    /** Pure validation: an error message for the current text, or undefined when writable. */
    validate: (text: string) => string | undefined;
    /** True while the write (and the re-read after it) is in flight. */
    pending: boolean;
    /** Write failure from the last commit attempt, shown until the next edit/commit. */
    writeError?: string;
    onCommit: (text: string) => void;
    onCancel: () => void;
}) {
    const [text, setText] = createSignal(props.initial);
    const error = () => props.validate(text());
    let cancelling = false;

    return (
        <span class="value-edit" onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
            <input
                class="value-edit-input"
                classList={{ invalid: error() !== undefined || props.writeError !== undefined, pending: props.pending }}
                value={text()}
                disabled={props.pending}
                spellcheck={false}
                aria-label="edit value"
                aria-invalid={error() !== undefined}
                ref={(el) => {
                    el.focus();
                    el.select();
                }}
                onInput={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                    e.stopPropagation(); // grid shortcuts must not fire while typing a value
                    if (e.key === "Enter") {
                        if (!props.pending && error() === undefined) props.onCommit(text());
                    } else if (e.key === "Escape") {
                        cancelling = true;
                        props.onCancel();
                    }
                }}
                onBlur={() => {
                    if (cancelling) {
                        cancelling = false;
                        return;
                    }
                    if (!props.pending) props.onCancel();
                }}
            />
            <Show when={props.pending}>
                <span class="value-edit-state pending">writing…</span>
            </Show>
            <Show when={!props.pending && (error() ?? props.writeError)}>
                {(msg) => (
                    <span class="value-edit-state error" title={msg()}>
                        {msg()}
                    </span>
                )}
            </Show>
        </span>
    );
}
