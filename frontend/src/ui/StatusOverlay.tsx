import { Show } from "solid-js";

// A status message layered over a panel body (loading / empty / error). Renders nothing
// when `message` is falsy, so call sites read as `message={condition && "text"}` and the
// overlay simply disappears when the condition is false. The host must be
// position:relative (the shared `.panel-body` is) for the overlay to fill it.

export interface StatusOverlayProps {
    message?: string | false | null;
    error?: boolean;
}

export function StatusOverlay(props: StatusOverlayProps) {
    return (
        <Show when={props.message}>
            {(message) => (
                <p class="panel-status overlay" classList={{ error: !!props.error }}>
                    {message()}
                </p>
            )}
        </Show>
    );
}
