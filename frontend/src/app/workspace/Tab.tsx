import { Icon } from "./icons";
import type { TabItem } from "../WorkspaceContext";

// A single tab: kind icon, title (ellipsised), and a close affordance. Presentational only - all
// state transitions are driven by the handlers the TabBar passes in.

export function Tab(props: {
    tab: TabItem;
    title: string;
    tooltip: string;
    active: boolean;
    dragging: boolean;
    tabIndex: number;
    onSelect: () => void;
    onClose: () => void;
    onContextMenu: (e: MouseEvent) => void;
    onPointerDown: (e: PointerEvent) => void;
}) {
    return (
        <div
            class="ws-tab"
            classList={{ active: props.active, dragging: props.dragging }}
            role="tab"
            aria-selected={props.active}
            tabindex={props.active ? 0 : -1}
            title={props.tooltip}
            data-tab-index={props.tabIndex}
            onPointerDown={props.onPointerDown}
            onClick={props.onSelect}
            onContextMenu={(e) => {
                e.preventDefault();
                props.onContextMenu(e);
            }}
            onAuxClick={(e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    props.onClose();
                }
            }}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    props.onSelect();
                }
            }}
        >
            <span class="ws-tab-icon">
                <Icon name={props.tab.kind} size={15} />
            </span>
            <span class="ws-tab-title">{props.title}</span>
            <button
                class="ws-tab-close"
                aria-label={`Close ${props.title}`}
                title="Close"
                tabindex={-1}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                    e.stopPropagation();
                    props.onClose();
                }}
            >
                <Icon name="close" size={13} />
            </button>
        </div>
    );
}
