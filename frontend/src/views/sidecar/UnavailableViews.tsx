import { CapabilityGate } from "../../app/CapabilityUnavailable";

// Honest capability-gated workspaces for features with no in-app backend. Each renders its real content
// ONLY if the capability negotiates available; otherwise the gate shows the exact missing Angel
// primitive and any supported alternative. No fake working controls. (The Network/PCAP workbench moved
// to views/network/NetworkView.tsx once the tshark sidecar adapter landed.)

export function DebuggerView() {
    return (
        <CapabilityGate id="debug.live" title="Live Debugger">
            <div class="capgate"><div class="capgate-card">Live debug provider connected.</div></div>
        </CapabilityGate>
    );
}

export function HookLabView() {
    return (
        <CapabilityGate id="hook.native" title="Hook Lab (native)">
            <div class="capgate"><div class="capgate-card">Native hook provider connected.</div></div>
        </CapabilityGate>
    );
}
