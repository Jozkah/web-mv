import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../AppContext";
import { useMemory } from "../../views/memory/state/MemoryContext";
import { useDismiss } from "../workspace/useDismiss";
import { resolveLabel } from "../../state/labels";

// The 24px status bar: persistent diagnostics moved out of the old top bar. Each item pairs a
// state glyph (shape, not colour alone) with concise text; clicking one opens details or recovery
// guidance. An off-screen aria-live region announces connection/attachment changes to assistive
// tech. Nothing here is colour-only — the glyph and text carry the same state.

type Tone = "live" | "warn" | "danger" | "idle";

function StatusItem(props: {
    tone: Tone;
    glyph: string;
    label: string;
    title: string;
    onClick?: () => void;
    accent?: boolean;
}) {
    return (
        <button
            class="status-item"
            classList={{ [`tone-${props.tone}`]: true, accent: props.accent }}
            title={props.title}
            onClick={props.onClick}
            disabled={!props.onClick}
        >
            <span class="status-glyph" aria-hidden="true">{props.glyph}</span>
            <span class="status-text">{props.label}</span>
        </button>
    );
}

export function StatusBar() {
    const app = useApp();
    const memory = useMemory();
    const [conn, setConn] = createSignal(false);
    let connRoot: HTMLDivElement | undefined;
    useDismiss(() => connRoot, () => setConn(false), conn);

    const [caps, setCaps] = createSignal(false);
    let capsRoot: HTMLDivElement | undefined;
    useDismiss(() => capsRoot, () => setCaps(false), caps);
    const capStore = app.capabilities;
    // Rendered from the negotiated capability set, never from assumptions: available first, then
    // unavailable with their exact missing primitive / reason.
    const capList = createMemo(() =>
        [...capStore.all()].sort((a, b) => Number(b.available) - Number(a.available)),
    );
    // Each provenance renders distinctly — `assumed` is never shown as equivalent to `confirmed`.
    const PROV: Record<string, { glyph: string; cls: string; label: string }> = {
        confirmed: { glyph: "●", cls: "prov-confirmed", label: "confirmed" },
        assumed: { glyph: "◐", cls: "prov-assumed", label: "assumed" },
        derived: { glyph: "◆", cls: "prov-derived", label: "derived" },
        unavailable: { glyph: "○", cls: "prov-unavailable", label: "unavailable" },
        disconnected: { glyph: "○", cls: "prov-disconnected", label: "disconnected" },
    };

    const serverTone = (): Tone =>
        app.relayStatus() === "open" ? "live" : app.relayStatus() === "connecting" ? "warn" : "danger";
    const serverGlyph = () =>
        app.relayStatus() === "open" ? "●" : app.relayStatus() === "connecting" ? "◐" : "○";

    const agentUp = () => app.pingData() !== undefined;
    const agentCount = () => app.activeAgents();

    const location = createMemo(() => {
        const e = app.nav.current();
        if (!e) return undefined;
        const label = e.label ?? resolveLabel(e.address, app.modules.list());
        return { address: e.address, label };
    });

    // Announce coarse connection / attachment transitions.
    const liveMsg = createMemo(() => {
        const server = app.relayStatus();
        const attached = app.attached();
        if (server !== "open") return `Server ${server}`;
        return attached ? `Attached to pid ${app.pid() ?? "?"}` : "Server connected, no process attached";
    });

    return (
        <footer class="statusbar">
            <div class="statusbar-group">
                <div class="status-anchor" ref={connRoot}>
                    <StatusItem
                        tone={serverTone()}
                        glyph={serverGlyph()}
                        label={`Server ${app.relayStatus()}`}
                        title="Relay connection — click for recovery guidance"
                        onClick={() => setConn((v) => !v)}
                        accent
                    />
                    <Show when={conn()}>
                        <div class="status-pop" role="dialog" aria-label="Connection details">
                            <div class="status-pop-head">Connection</div>
                            <div class="status-pop-row"><span>Relay</span><b>{app.relayStatus()}</b></div>
                            <div class="status-pop-row"><span>Core agents</span><b>{agentCount()}</b></div>
                            <div class="status-pop-row"><span>Extension agent</span><b>{app.extConnected() ? "connected" : "absent"}</b></div>
                            <Show when={app.relayStatus() !== "open"}>
                                <p class="status-pop-note">The relay socket is not open. Start the web-mv relay (binds 127.0.0.1:9000) and this UI reconnects automatically.</p>
                            </Show>
                            <Show when={app.relayStatus() === "open" && !app.extConnected()}>
                                <p class="status-pop-note">Load <code>web_mv_ext_agent.as</code> to enable memory writes, dumps, exports and section reads.</p>
                            </Show>
                        </div>
                    </Show>
                </div>

                <StatusItem
                    tone={agentUp() ? "live" : "idle"}
                    glyph={agentUp() ? "●" : "○"}
                    label={agentCount() > 1 ? `Agents ${agentCount()}` : `Agent ${agentUp() ? "up" : "down"}`}
                    title="Core RPC agent connection"
                />
                <StatusItem
                    tone={app.extConnected() ? "live" : "idle"}
                    glyph={app.extConnected() ? "●" : "○"}
                    label={`Ext ${app.extConnected() ? "up" : "down"}`}
                    title="Extension agent (write / dump / exports / sections)"
                />

                <div class="status-anchor" ref={capsRoot}>
                    <StatusItem
                        tone={capStore.availableCount() > 0 ? "live" : "idle"}
                        glyph="◧"
                        label={`Caps ${capStore.availableCount()}/${capStore.totalCount()}`}
                        title="Negotiated capabilities — click to see what is available and what is missing"
                        onClick={() => setCaps((v) => !v)}
                    />
                    <Show when={caps()}>
                        <div class="status-pop status-pop-wide" role="dialog" aria-label="Capabilities">
                            <div class="status-pop-head">
                                Capabilities
                                <Show when={capStore.handshake() === "assumed"}>
                                    <span class="status-pop-warn" title="Ext agent predates the capabilities handshake; verbs are assumed, not confirmed"> · assumed</span>
                                </Show>
                                <Show when={capStore.protocolMismatch()}>
                                    <span class="status-pop-warn" title="Ext agent protocol version differs from the frontend"> · protocol mismatch</span>
                                </Show>
                            </div>
                            <div class="status-cap-list">
                                <For each={capList()}>
                                    {(c) => (
                                        <div
                                            class="status-cap-row"
                                            classList={{ on: c.available, off: !c.available, [PROV[c.provenance].cls]: true }}
                                            title={
                                                c.available
                                                    ? `${PROV[c.provenance].label} · ${c.level} · ${c.detail}`
                                                    : `${PROV[c.provenance].label} · ${c.level} · ${c.reason ?? c.detail}${c.missingPrimitive ? `\nmissing: ${c.missingPrimitive}` : ""}${c.alternative ? `\nalternative: ${c.alternative}` : ""}`
                                            }
                                        >
                                            <span class="status-cap-glyph" aria-hidden="true">{PROV[c.provenance].glyph}</span>
                                            <span class="status-cap-name">{c.title}</span>
                                            <span class="status-cap-prov">{PROV[c.provenance].label}</span>
                                        </div>
                                    )}
                                </For>
                            </div>
                            <p class="status-pop-note">Confirmed = backend reported it. Assumed = older agent, unverified. Derived = built on another capability. Unavailable capabilities show the exact missing Angel primitive on hover. Emulation is an emulator, never a live debugger.</p>
                        </div>
                    </Show>
                </div>
            </div>

            <div class="statusbar-spacer" />

            <div class="statusbar-group">
                <Show
                    when={app.attached()}
                    fallback={<StatusItem tone="idle" glyph="○" label="No target" title="No process attached" />}
                >
                    <StatusItem
                        tone={app.isFollowingLive() ? "live" : "warn"}
                        glyph={app.isFollowingLive() ? "▮" : "▯"}
                        label={app.isFollowingLive() ? "Live" : "Saved"}
                        title={app.isFollowingLive() ? "Following the attached process (polling)" : "Viewing a saved workspace (not live)"}
                    />
                    <Show when={app.processName()}>
                        {(name) => <StatusItem tone="idle" glyph="▣" label={name()} title="Attached process (main module)" />}
                    </Show>
                    <StatusItem tone="idle" glyph="#" label={`pid ${app.pid()}`} title="Attached process id" />
                    <Show when={app.base()}>
                        <StatusItem tone="idle" glyph="⌂" label={`base ${app.base()}`} title="Main module base address" />
                    </Show>
                </Show>

                <Show when={location()}>
                    {(loc) => (
                        <StatusItem
                            tone="idle"
                            glyph="→"
                            label={loc().label}
                            title={`Current location — ${loc().address}`}
                        />
                    )}
                </Show>

                <Show when={memory.canUndo || memory.canRedo}>
                    <StatusItem
                        tone="idle"
                        glyph="↶"
                        label={memory.canRedo ? "undo / redo" : "undo ready"}
                        title="Memory edits can be undone (Ctrl+Z) / redone (Ctrl+Shift+Z)"
                    />
                </Show>
            </div>

            <p class="sr-only" aria-live="polite">{liveMsg()}</p>
        </footer>
    );
}
