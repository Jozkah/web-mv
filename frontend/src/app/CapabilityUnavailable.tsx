import { Show, type JSX } from "solid-js";
import { useApp } from "./AppContext";
import type { CapabilityId } from "../protocol/capabilities";
import "./capability-gate.css";

// A reusable, honest capability gate. When the capability is available it renders its children;
// otherwise it renders exactly WHY — the support level, the missing Angel primitive (or missing
// sidecar), the user-facing reason, and any supported alternative — never a fake working control.
// This is the single component every "unavailable" workspace (decompiler, network, debugger, hooks)
// renders from, so honesty is uniform.

export function CapabilityGate(props: {
    id: CapabilityId;
    title: string;
    /** Extra guidance for optional-sidecar capabilities: how to configure the tool to enable it. */
    enableHint?: JSX.Element;
    children: JSX.Element;
}) {
    const app = useApp();
    const status = () => app.capabilities.get(props.id);

    return (
        <Show when={status().available} fallback={<UnavailablePanel id={props.id} title={props.title} enableHint={props.enableHint} />}>
            {props.children}
        </Show>
    );
}

export function UnavailablePanel(props: { id: CapabilityId; title: string; enableHint?: JSX.Element }) {
    const app = useApp();
    const s = () => app.capabilities.get(props.id);
    return (
        <div class="capgate">
            <div class="capgate-card">
                <div class="capgate-head">
                    <span class="capgate-title">{props.title}</span>
                    <span class="capgate-level" title="How this capability would be provided">{s().level}</span>
                    <span class="capgate-prov" title="Negotiated state">{s().provenance}</span>
                </div>
                <div class="capgate-status">Unavailable</div>
                <Show when={s().reason}><p class="capgate-reason">{s().reason}</p></Show>
                <Show when={s().missingPrimitive}>
                    <div class="capgate-row"><span class="capgate-label">Missing</span><code>{s().missingPrimitive}</code></div>
                </Show>
                <Show when={s().alternative}>
                    <div class="capgate-row"><span class="capgate-label">Alternative</span><code>{s().alternative}</code></div>
                </Show>
                <Show when={props.enableHint}>
                    <div class="capgate-hint">{props.enableHint}</div>
                </Show>
            </div>
        </div>
    );
}
