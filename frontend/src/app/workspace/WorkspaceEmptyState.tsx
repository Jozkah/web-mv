import { For } from "solid-js";
import { Icon } from "./icons";
import { PRIMARY_KINDS } from "./tabKinds";
import type { TabKind } from "../WorkspaceContext";

// Shown when a group has no open tabs. A calm, useful default rather than a blank panel - the
// primary views are one click away.

export function WorkspaceEmptyState(props: { onOpen: (kind: TabKind) => void }) {
    return (
        <div class="ws-empty">
            <div class="ws-empty-inner">
                <p class="ws-empty-title">No tabs open</p>
                <p class="ws-empty-sub">Open a view to get started</p>
                <div class="ws-empty-actions">
                    <For each={PRIMARY_KINDS}>
                        {(meta) => (
                            <button class="ws-empty-btn" onClick={() => props.onOpen(meta.kind)}>
                                <Icon name={meta.kind} size={16} />
                                {meta.label}
                            </button>
                        )}
                    </For>
                </div>
            </div>
        </div>
    );
}
