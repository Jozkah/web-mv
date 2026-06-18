import type { JSX } from "solid-js";

// The framed panel shell shared by every workspace pane: a titled head with an optional
// meta line (flex-grows to push actions right) and optional action buttons, then the
// caller's body. Callers supply whatever goes under the head (bars, list, editor host)
// as children, so the panel stays layout-agnostic.

export interface PanelProps {
    title: string;
    /** Optional layout class for the panel frame (sizing lives in the view's CSS). */
    class?: string;
    /** Optional inline style, e.g. a content-derived width. */
    style?: JSX.CSSProperties;
    /** Secondary line beside the title - a count, a selection summary, etc. */
    meta?: JSX.Element;
    /** Right-aligned controls in the head, e.g. a refresh button. */
    actions?: JSX.Element;
    children: JSX.Element;
}

export function Panel(props: PanelProps) {
    return (
        <section class={`panel${props.class ? ` ${props.class}` : ""}`} style={props.style}>
            <header class="panel-head">
                <h2>{props.title}</h2>
                <span class="meta">{props.meta}</span>
                {props.actions}
            </header>
            {props.children}
        </section>
    );
}
