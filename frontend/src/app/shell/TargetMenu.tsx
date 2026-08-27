import { For, Show, createSignal } from "solid-js";
import { Icon } from "../workspace/icons";
import { useApp } from "../AppContext";
import { useDismiss } from "../workspace/useDismiss";
import { targetLabel, NO_TARGET_KEY } from "../../state/workspaceKey";

// Compact target switcher for the application bar. Replaces the old full-width target-tab strip.
// Distinguishes three states: Follow Live (green, tracks the attached process), the active saved
// workspace, and disconnected historical workspaces. Shows process name/PID, base and state.
// Forgetting a target confirms first when that target's saved workspace is not the live one.

export function TargetMenu() {
    const app = useApp();
    const [open, setOpen] = createSignal(false);
    let root: HTMLDivElement | undefined;
    useDismiss(() => root, () => setOpen(false), open);

    const liveAttached = () => app.liveKey() !== NO_TARGET_KEY;

    // The button's label reflects what the workspace is currently bound to.
    const currentLabel = () => {
        if (app.isFollowingLive()) {
            return liveAttached()
                ? targetLabel({ key: app.liveKey(), pid: app.pid(), base: app.base(), name: app.processName(), lastSeen: 0 })
                : "No target";
        }
        const t = app.targets().find((t) => t.key === app.workspaceKey());
        return t ? targetLabel(t) : "Saved target";
    };

    const forget = (key: string, label: string) => {
        // Only confirm when leaving a non-live saved workspace (it may hold classes/annotations
        // reachable nowhere else once forgotten).
        if (key === app.liveKey() || window.confirm(`Forget target ${label}? Its saved workspace stays on disk but leaves this list.`)) {
            app.forgetTarget(key);
        }
    };

    return (
        <div class="target-switch" ref={root}>
            <button
                class="target-btn"
                classList={{ live: app.isFollowingLive() && liveAttached(), open: open() }}
                aria-haspopup="menu"
                aria-expanded={open()}
                title="Target / workspace"
                onClick={() => setOpen((v) => !v)}
            >
                <span class="dot" classList={{ live: app.isFollowingLive() ? liveAttached() : false }} />
                <span class="target-btn-label">{currentLabel()}</span>
                <Show when={app.isFollowingLive()}>
                    <span class="target-btn-tag">live</span>
                </Show>
                <Icon name="chevron-down" size={13} />
            </button>

            <Show when={open()}>
                <div class="target-pop" role="menu">
                    <button
                        class="target-pop-row"
                        classList={{ active: app.isFollowingLive() }}
                        role="menuitemradio"
                        aria-checked={app.isFollowingLive()}
                        onClick={() => {
                            app.followLive();
                            setOpen(false);
                        }}
                    >
                        <span class="dot" classList={{ live: liveAttached() }} />
                        <span class="target-pop-main">
                            <span class="target-pop-name">Follow Live</span>
                            <span class="target-pop-sub">
                                {liveAttached()
                                    ? `${targetLabel({ key: app.liveKey(), pid: app.pid(), base: app.base(), name: app.processName(), lastSeen: 0 })} · base ${app.base() ?? "—"}`
                                    : "waiting for an attached process"}
                            </span>
                        </span>
                        <Show when={app.isFollowingLive()}>
                            <span class="target-pop-check">✓</span>
                        </Show>
                    </button>

                    <Show when={app.targets().length > 0}>
                        <div class="target-pop-sep" />
                        <div class="target-pop-head">Saved workspaces</div>
                        <For each={app.targets()}>
                            {(t) => {
                                const active = () => !app.isFollowingLive() && app.workspaceKey() === t.key;
                                const isLive = () => t.key === app.liveKey();
                                return (
                                    <div class="target-pop-row" classList={{ active: active() }} role="menuitemradio" aria-checked={active()}>
                                        <button
                                            class="target-pop-pick"
                                            onClick={() => {
                                                app.selectTarget(t.key);
                                                setOpen(false);
                                            }}
                                        >
                                            <span class="dot" classList={{ live: isLive() }} />
                                            <span class="target-pop-main">
                                                <span class="target-pop-name">{targetLabel(t)}</span>
                                                <span class="target-pop-sub">
                                                    {isLive() ? "attached now" : "disconnected"}
                                                    {t.base ? ` · base ${t.base}` : ""}
                                                </span>
                                            </span>
                                        </button>
                                        <button
                                            class="target-pop-forget"
                                            title="Forget this target"
                                            aria-label={`Forget ${targetLabel(t)}`}
                                            onClick={() => forget(t.key, targetLabel(t))}
                                        >
                                            <Icon name="close" size={12} />
                                        </button>
                                    </div>
                                );
                            }}
                        </For>
                    </Show>
                </div>
            </Show>
        </div>
    );
}
