import { For } from "solid-js";
import { Icon } from "./icons";
import { useDismiss } from "./useDismiss";
import { defaultTabTitle, type TabGroup } from "../WorkspaceContext";

// Dropdown that lists every tab in the group so any tab can be found and selected even when the
// strip has overflowed. Anchored under the overflow (chevron) button on the right.

export function TabOverflowMenu(props: {
    group: TabGroup;
    onSelect: (tabId: string) => void;
    onClose: () => void;
}) {
    let root: HTMLDivElement | undefined;
    useDismiss(() => root, props.onClose);

    const select = (id: string) => {
        props.onSelect(id);
        props.onClose();
    };

    return (
        <div ref={root} class="ws-menu ws-menu--overflow" role="menu" aria-label="Open tabs">
            <For each={props.group.tabs}>
                {(tab) => (
                    <button
                        class="ws-menu-item ws-menu-item--tab"
                        classList={{ active: tab.id === props.group.activeTabId }}
                        role="menuitem"
                        onClick={() => select(tab.id)}
                    >
                        <span class="ws-menu-item-icon">
                            <Icon name={tab.kind} size={15} />
                        </span>
                        <span class="ws-menu-item-label">{tab.title || defaultTabTitle(tab.kind)}</span>
                    </button>
                )}
            </For>
        </div>
    );
}
