import { Show } from "solid-js";
import { useWorkspace } from "../WorkspaceContext";
import { useDismiss } from "./useDismiss";

// Right-click menu for a single tab. Positioned at the cursor. Only shows actions that make sense
// for the tab's position (e.g. "Close Tabs to the Right" is hidden for the last tab).

export function TabContextMenu(props: {
    tabId: string;
    x: number;
    y: number;
    onClose: () => void;
}) {
    let root: HTMLDivElement | undefined;
    const ws = useWorkspace();
    useDismiss(() => root, props.onClose);

    const group = () => ws.groups.find((g) => g.tabs.some((t) => t.id === props.tabId));
    const index = () => group()?.tabs.findIndex((t) => t.id === props.tabId) ?? -1;
    const count = () => group()?.tabs.length ?? 0;

    const run = (fn: () => void) => {
        fn();
        props.onClose();
    };

    // Keep the menu inside the viewport.
    const left = () => Math.min(props.x, window.innerWidth - 210);
    const top = () => Math.min(props.y, window.innerHeight - 220);

    return (
        <div
            ref={root}
            class="ws-menu ws-menu--context"
            role="menu"
            style={{ left: `${left()}px`, top: `${top()}px` }}
        >
            <button class="ws-menu-item" role="menuitem" onClick={() => run(() => ws.closeTab(props.tabId))}>
                Close
            </button>
            <Show when={count() > 1}>
                <button
                    class="ws-menu-item"
                    role="menuitem"
                    onClick={() => run(() => ws.closeOtherTabs(props.tabId))}
                >
                    Close Other Tabs
                </button>
            </Show>
            <Show when={index() >= 0 && index() < count() - 1}>
                <button
                    class="ws-menu-item"
                    role="menuitem"
                    onClick={() => run(() => ws.closeTabsToRight(props.tabId))}
                >
                    Close Tabs to the Right
                </button>
            </Show>

            <div class="ws-menu-sep" role="separator" />

            <button class="ws-menu-item" role="menuitem" onClick={() => run(() => ws.duplicateTab(props.tabId))}>
                Duplicate
            </button>
            <button class="ws-menu-item" role="menuitem" onClick={() => run(() => ws.moveTabToSide(props.tabId))}>
                Open to the Side
            </button>
        </div>
    );
}
