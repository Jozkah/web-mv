import { For, Show } from "solid-js";
import { Icon } from "./icons";
import { useDismiss } from "./useDismiss";
import { PRIMARY_KINDS, SECONDARY_KINDS, type TabKindMeta } from "./tabKinds";
import type { TabKind } from "../WorkspaceContext";

// The "+ New tab" command menu: a compact, scannable list of every openable view with a short
// description. Rendered as a popover anchored under the + button.

export function NewTabMenu(props: { onPick: (kind: TabKind) => void; onClose: () => void }) {
    let root: HTMLDivElement | undefined;
    useDismiss(() => root, props.onClose);

    const pick = (kind: TabKind) => {
        props.onPick(kind);
        props.onClose();
    };

    const item = (meta: TabKindMeta) => (
        <button class="ws-menu-item ws-menu-item--rich" role="menuitem" onClick={() => pick(meta.kind)}>
            <span class="ws-menu-item-icon">
                <Icon name={meta.kind} size={16} />
            </span>
            <span class="ws-menu-item-body">
                <span class="ws-menu-item-label">{meta.label}</span>
                <span class="ws-menu-item-desc">{meta.description}</span>
            </span>
        </button>
    );

    return (
        <div ref={root} class="ws-menu ws-menu--new" role="menu" aria-label="Open new tab">
            <div class="ws-menu-head">Open new tab</div>
            <For each={PRIMARY_KINDS}>{item}</For>
            <Show when={SECONDARY_KINDS.length > 0}>
                <div class="ws-menu-sep" role="separator" />
            </Show>
            <For each={SECONDARY_KINDS}>{item}</For>
        </div>
    );
}
