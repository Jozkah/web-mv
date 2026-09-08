import { For, Show, createEffect, on } from "solid-js";
import { useApp } from "../../app/AppContext";
import { CapabilityGate } from "../../app/CapabilityUnavailable";
import type { UiControl } from "../../protocol/types";
import "../../ui/panels.css";
import "./menu.css";

// Menu Control: lists and toggles the connected ext agent's own overlay controls over the
// ui_list/ui_get/ui_set lane. Gated on the menu.control capability (CapabilityGate below) — the
// body only renders once the ext agent is connected and advertises ui_list. Danger controls are
// disabled client-side until the overlay's own ARM button flips `armed` — the agent refuses them
// either way (error 1024), this is just an honest hint, not the enforcement.

export function MenuControlView() {
    return (
        <CapabilityGate id="menu.control" title="Menu Control">
            <MenuControlBody />
        </CapabilityGate>
    );
}

function MenuControlBody() {
    const app = useApp();
    const mc = app.menuControl;

    // Load the control list once the capability becomes available (and whenever it flips back on
    // after a reconnect) rather than only on the first mount.
    createEffect(
        on(mc.available, (avail) => {
            if (avail) mc.refresh();
        }),
    );

    return (
        <div class="panel mc-view">
            <div class="panel-head">
                <h2>Menu Control</h2>
                <span class="meta">
                    <Show when={mc.armed()} fallback={<span class="mc-armed off">disarmed</span>}>
                        <span class="mc-armed on">ARMED</span>
                    </Show>
                    <Show when={mc.controls().length > 0}> · {mc.controls().length} controls</Show>
                </span>
                <button onClick={() => mc.refresh()} disabled={mc.loading()}>
                    {mc.loading() ? "…" : "↻ Refresh"}
                </button>
            </div>
            <div class="panel-body mc-body">
                <Show when={mc.error()}>
                    <div class="panel-status error mc-error">{mc.error()}</div>
                </Show>
                <Show
                    when={mc.controls().length > 0}
                    fallback={
                        <div class="panel-status">
                            {mc.loading() ? "Loading controls…" : "No controls reported. Click Refresh."}
                        </div>
                    }
                >
                    <div class="list mc-list">
                        <For each={mc.controls()}>{(c) => <ControlRow control={c} />}</For>
                    </div>
                </Show>
            </div>
            <p class="mc-note">
                Reads and writes the connected ext agent's own overlay controls (web_mv_ext_agent.as's
                ui_list/ui_get/ui_set lane) — never game/process memory beyond what a control itself is
                wired to.
            </p>
        </div>
    );
}

function ControlRow(props: { control: UiControl }) {
    const app = useApp();
    const mc = app.menuControl;
    const c = () => props.control;
    const locked = () => c().danger && !mc.armed();

    const onCheck = (checked: boolean) => mc.setControl(c().name, checked);
    const onSlider = (raw: string) => {
        const n = Number(raw);
        if (Number.isFinite(n)) mc.setControl(c().name, n);
    };
    const onCombo = (raw: string) => {
        const n = Number(raw);
        if (Number.isFinite(n)) mc.setControl(c().name, n);
    };

    return (
        <div class="row mc-row" classList={{ danger: c().danger, locked: locked() }}>
            <span class="grow mc-name" title={c().name}>
                {c().name}
                <Show when={c().danger}>
                    <span class="mc-badge danger" title="Danger control — needs the overlay's ARM">danger</span>
                </Show>
            </span>
            <span class="mc-kind dim">{c().kind}</span>
            <span class="mc-control">
                <Show when={c().kind === "check"}>
                    <input
                        type="checkbox"
                        checked={c().value === true}
                        disabled={locked()}
                        aria-label={c().name}
                        onChange={(e) => onCheck(e.currentTarget.checked)}
                    />
                </Show>
                <Show when={c().kind === "slider"}>
                    <span class="mc-slider">
                        <input
                            type="range"
                            min={c().min ?? 0}
                            max={c().max ?? 100}
                            step={c().step ?? 1}
                            value={typeof c().value === "number" ? (c().value as number) : 0}
                            disabled={locked()}
                            aria-label={c().name}
                            onInput={(e) => onSlider(e.currentTarget.value)}
                        />
                        <input
                            type="number"
                            class="mc-num"
                            min={c().min ?? 0}
                            max={c().max ?? 100}
                            step={c().step ?? 1}
                            value={typeof c().value === "number" ? (c().value as number) : 0}
                            disabled={locked()}
                            aria-label={`${c().name} value`}
                            onChange={(e) => onSlider(e.currentTarget.value)}
                        />
                    </span>
                </Show>
                <Show when={c().kind === "combo"}>
                    <select
                        disabled={locked()}
                        aria-label={c().name}
                        value={String(typeof c().value === "number" ? c().value : 0)}
                        onChange={(e) => onCombo(e.currentTarget.value)}
                    >
                        <For each={c().options ?? []}>{(opt, i) => <option value={i()}>{opt}</option>}</For>
                    </select>
                </Show>
            </span>
            <Show when={locked()}>
                <span class="mc-hint">Danger control — click &ldquo;Menu Control: ARM danger controls&rdquo; in the overlay to enable.</span>
            </Show>
        </div>
    );
}
