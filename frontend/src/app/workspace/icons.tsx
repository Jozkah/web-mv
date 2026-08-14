import type { JSX } from "solid-js";
import type { TabKind } from "../WorkspaceContext";

// Small, consistent line icons drawn as inline SVG so the workspace has no icon-font or image
// dependency. Every glyph is a 16x16 viewBox, 1.5px stroke, `currentColor` - so it inherits the
// tab's text colour and tracks the theme automatically. Kept deliberately spare to read cleanly
// at 14-16px in a dense tool UI.

type IconName =
    | TabKind
    | "close"
    | "plus"
    | "chevron-down"
    | "split";

const PATHS: Record<IconName, JSX.Element> = {
    // Memory chip: a die with pins on two sides.
    memory: (
        <>
            <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
            <path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" />
        </>
    ),
    // Modules / static analysis: stacked layers.
    static: (
        <>
            <path d="M8 2.5 14 5.5 8 8.5 2 5.5 8 2.5Z" />
            <path d="M2.5 8 8 10.75 13.5 8" />
            <path d="M2.5 10.75 8 13.5 13.5 10.75" />
        </>
    ),
    // Strings: left-aligned text lines.
    strings: (
        <>
            <path d="M3 4h10M3 8h10M3 12h6" />
        </>
    ),
    // History: a counter-clockwise arrow around a clock.
    history: (
        <>
            <path d="M3 8a5 5 0 1 1 1.6 3.65" />
            <path d="M3 8V4.8M3 8h3.1" />
            <path d="M8 5.6V8l1.8 1.1" />
        </>
    ),
    // Signature scan: a crosshair / target.
    sigscan: (
        <>
            <circle cx="8" cy="8" r="4.2" />
            <path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2" />
        </>
    ),
    // Analysis: a call-graph of connected nodes.
    analysis: (
        <>
            <circle cx="4" cy="4.5" r="1.6" />
            <circle cx="12" cy="6" r="1.6" />
            <circle cx="6.5" cy="12" r="1.6" />
            <path d="M5.4 5.4 11 5.9M5.2 6 6.2 10.5M7.9 11.4 10.9 7.2" />
        </>
    ),
    // Data types: braces around a field row, hinting at a struct definition.
    datatypes: (
        <>
            <path d="M6 3.5C4.5 3.5 4.5 5 4.5 6.5S3 8 3 8s1.5 0 1.5 1.5S4.5 12.5 6 12.5" />
            <path d="M10 3.5c1.5 0 1.5 1.5 1.5 3S13 8 13 8s-1.5 0-1.5 1.5.0 3-1.5 3" />
        </>
    ),
    // Cheat table: a small grid table.
    cheat: (
        <>
            <rect x="3" y="3.5" width="10" height="9" rx="1" />
            <path d="M3 6.5h10M7 6.5v6" />
        </>
    ),
    // PE / symbols: a document with a folded corner.
    pe: (
        <>
            <path d="M4 2.5h5l3 3v8a0 0 0 0 1 0 0H4Z" />
            <path d="M9 2.5v3h3" />
        </>
    ),
    // Bookmarks: a ribbon.
    bookmarks: (
        <>
            <path d="M4.5 2.5h7v11l-3.5-2.5L4.5 13.5Z" />
        </>
    ),
    // Snapshot diff: two opposed compare arrows.
    diff: (
        <>
            <path d="M5.5 3.5 3 6l2.5 2.5M3 6h7.5" />
            <path d="M10.5 12.5 13 10l-2.5-2.5M13 10H5.5" />
        </>
    ),
    // Hex inspector: a grid of cells.
    hex: (
        <>
            <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
            <path d="M6 3.5v9M10 3.5v9M2.5 6.5h11M2.5 9.5h11" />
        </>
    ),
    // Memory map: stacked address bands of varying width.
    regions: (
        <>
            <path d="M2.5 3.5h11M2.5 6.5h8M2.5 9.5h11M2.5 12.5h6" />
        </>
    ),
    // Value scanner: a magnifier over a grid.
    scanner: (
        <>
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
        </>
    ),
    // Pointer chain: linked nodes.
    pointer: (
        <>
            <circle cx="4" cy="8" r="1.8" />
            <circle cx="12" cy="8" r="1.8" />
            <path d="M5.8 8h4.4" />
        </>
    ),
    close: <path d="M4 4l8 8M12 4l-8 8" />,
    plus: <path d="M8 3.5v9M3.5 8h9" />,
    "chevron-down": <path d="M4 6l4 4 4-4" />,
    split: (
        <>
            <rect x="2.5" y="3" width="11" height="10" rx="1" />
            <path d="M8 3v10" />
        </>
    ),
};

export function Icon(props: { name: IconName; size?: number; class?: string }): JSX.Element {
    return (
        <svg
            class={props.class}
            width={props.size ?? 15}
            height={props.size ?? 15}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            {PATHS[props.name]}
        </svg>
    );
}
