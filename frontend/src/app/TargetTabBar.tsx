import { For, Show } from "solid-js";
import { useApp } from "./AppContext";
import { targetLabel, NO_TARGET_KEY } from "../state/workspaceKey";

// Target tab strip: one chip per process the user has attached to, each backed by its own
// workspace key (its own classes/annotations). "Live" follows whatever the agent is attached to
// right now; selecting another chip pins the workspace to that target's saved state so it can be
// reviewed even while attached elsewhere.
export function TargetTabBar() {
    const app = useApp();

    const isActive = (key: string) => !app.isFollowingLive() && app.workspaceKey() === key;

    return (
        <div class="target-tabbar">
            <button
                class="target-tab live"
                classList={{ active: app.isFollowingLive() }}
                onClick={() => app.followLive()}
                title="Follow the currently attached process"
            >
                <span class="target-dot" classList={{ up: app.liveKey() !== NO_TARGET_KEY }} />
                Live
                <Show when={app.liveKey() !== NO_TARGET_KEY}>
                    <span class="target-sub">
                        {targetLabel({ key: app.liveKey(), pid: app.pid(), base: app.base(), lastSeen: 0 })}
                    </span>
                </Show>
            </button>

            <For each={app.targets()}>
                {(t) => (
                    <button
                        class="target-tab"
                        classList={{ active: isActive(t.key) }}
                        onClick={() => app.selectTarget(t.key)}
                        title={`View saved workspace for ${targetLabel(t)}`}
                    >
                        {targetLabel(t)}
                        <span
                            class="target-forget"
                            title="Forget this target"
                            onClick={(e) => {
                                e.stopPropagation();
                                app.forgetTarget(t.key);
                            }}
                        >
                            ×
                        </span>
                    </button>
                )}
            </For>
        </div>
    );
}
