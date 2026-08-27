import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { validateGhidraConfig } from "../../state/ghidraConfig";
import type { GhidraSidecarState } from "../../state/decompilerStore";
import "./decompiler.css";

// Optional Ghidra decompiler with a strict split: module analysis loads only bounded METADATA (no
// pseudocode); pseudocode is fetched ONLY when the user clicks "Decompile selected function", and is
// cached. Every result is STATIC analysis (provenance Ghidra) — may be incomplete, incorrect, stale,
// or mismapped — and never touches the target. Navigation is offered only for mapped addresses.

const STATE_LABEL: Record<GhidraSidecarState, { text: string; tone: string }> = {
    unconfigured: { text: "unconfigured", tone: "off" },
    pathValid: { text: "path valid", tone: "warn" },
    readyUnvalidated: { text: "ready (unvalidated)", tone: "warn" },
    liveValidated: { text: "validated", tone: "ok" },
    failed: { text: "failed", tone: "danger" },
    timedOut: { text: "timed out", tone: "danger" },
};

export function DecompilerView() {
    const app = useApp();
    const d = app.decompiler;
    const cfg = () => app.ghidra.config();
    const [selectedModule, setSelectedModule] = createSignal<string>();
    const [selectedFn, setSelectedFn] = createSignal<string>(); // ghidra address of the selected function

    const status = () => app.capabilities.get("decompiler.ghidra");
    const errors = createMemo(() => validateGhidraConfig(cfg()));
    const funcs = () => (selectedModule() ? d.metadata(selectedModule()!) : undefined);
    const current = createMemo(() => funcs()?.find((f) => f.ghidraAddress === selectedFn()));
    const pseudo = createMemo(() => (selectedModule() && selectedFn() ? d.cachedPseudo(selectedModule()!, selectedFn()!) : undefined));

    const analyze = () => {
        const m = selectedModule() ?? app.modules.list()[0]?.name;
        if (m) { setSelectedModule(m); setSelectedFn(undefined); d.analyzeModule(m); }
    };
    const decompile = () => {
        const m = selectedModule();
        const f = current();
        if (m && f) d.decompileFunction(m, f.ghidraAddress);
    };

    const decompileDisabled = () =>
        !status().available || !current() || d.decompileBusy() === current()?.ghidraAddress || d.jobState() === "analyzing";

    const st = () => STATE_LABEL[d.sidecarState()];

    return (
        <div class="dc-view">
            <div class="dc-config">
                <div class="dc-section">Ghidra headless (local, user-supplied — nothing downloaded)</div>
                <div class="dc-grid">
                    <label>Enabled</label>
                    <input type="checkbox" checked={cfg().enabled} onChange={(e) => app.ghidra.update({ enabled: e.currentTarget.checked })} />
                    <label>analyzeHeadless path</label>
                    <input value={cfg().analyzeHeadlessPath} placeholder="C:\\ghidra\\support\\analyzeHeadless.bat" onChange={(e) => app.ghidra.update({ analyzeHeadlessPath: e.currentTarget.value })} />
                    <label>Dump directory</label>
                    <input value={cfg().dumpDirectory ?? ""} placeholder="Angel <scripts>\\dmp" onChange={(e) => app.ghidra.update({ dumpDirectory: e.currentTarget.value })} />
                    <label>Timeout (ms)</label>
                    <input type="number" value={cfg().defaultTimeoutMs} onChange={(e) => app.ghidra.update({ defaultTimeoutMs: Number(e.currentTarget.value) })} />
                </div>
                <div class="dc-statusline">
                    <span class={`dc-pill ${st().tone}`}>{st().text}</span>
                    <span class="dc-prov">{status().provenance} · {status().level}</span>
                    <Show when={!status().available && status().reason}><span class="dc-reason">{status().reason}</span></Show>
                    <Show when={errors().length > 0}><span class="dc-reason">{errors().join("; ")}</span></Show>
                    <Show when={d.sidecarState() === "readyUnvalidated"}><span class="dc-reason">path exists but no dump analysis has succeeded yet</span></Show>
                </div>
            </div>

            <div class="dc-toolbar">
                <select class="dc-select" value={selectedModule() ?? ""} onChange={(e) => { setSelectedModule(e.currentTarget.value || undefined); setSelectedFn(undefined); }} disabled={!status().available}>
                    <option value="">(select module)</option>
                    <For each={app.modules.list()}>{(m) => <option value={m.name}>{m.name}</option>}</For>
                </select>
                <button class="dc-btn" disabled={!status().available || d.jobState() === "dumping" || d.jobState() === "analyzing"} onClick={analyze}>
                    {d.jobState() === "dumping" ? "dumping…" : d.jobState() === "analyzing" ? "analyzing…" : "Analyze module"}
                </button>
                <button class="dc-btn primary" disabled={decompileDisabled()} onClick={decompile} title="Decompile the selected function (explicit, on-demand)">
                    {d.decompileBusy() === current()?.ghidraAddress ? "decompiling…" : "Decompile selected function"}
                </button>
                <span class="dc-job">{d.jobState()}</span>
                <Show when={d.lastError()}><span class="dc-reason">{d.lastError()}</span></Show>
            </div>

            <Show when={!status().available}>
                <div class="dc-banner">Point <code>analyzeHeadless</code> at your local Ghidra and set the Angel dump directory, then the relay probe enables this. Angel remains the dump source; Ghidra never attaches to the target.</div>
            </Show>

            <div class="dc-body">
                <div class="dc-list">
                    <Show when={funcs()} fallback={<div class="dc-empty">{status().available ? "Analyze a module to load its function list (metadata only — no decompilation)." : "Configure Ghidra above."}</div>}>
                        <div class="dc-warn">Static analysis (Ghidra). Function list only — no pseudocode until you explicitly decompile.</div>
                        <For each={funcs()}>
                            {(f) => (
                                <div class="dc-fn-row" classList={{ sel: selectedFn() === f.ghidraAddress }} onClick={() => setSelectedFn(f.ghidraAddress)}>
                                    <span class="dc-fn-addr" classList={{ unmapped: !f.mapped }} title={f.mapped ? `live ${f.liveAddress}` : "unmapped — no live address"}>{f.liveAddress ?? f.ghidraAddress}{!f.mapped ? " (unmapped)" : ""}</span>
                                    <span class="dc-fn-name">{f.name ?? "(anon)"}</span>
                                    <span class="dc-fn-sig">{f.signature ?? ""}</span>
                                </div>
                            )}
                        </For>
                    </Show>
                </div>

                <div class="dc-detail">
                    <Show when={current()} fallback={<div class="dc-empty">Select a function.</div>}>
                        {(f) => (
                            <>
                                <div class="dc-detail-head">
                                    <span class="dc-fn-name">{f().name ?? "(anon)"}</span>
                                    <span class={`dc-conf ${f().confidence}`} title="address mapping confidence">{f().confidence}</span>
                                </div>
                                <dl class="dc-fields">
                                    <dt>Live</dt><dd>{f().liveAddress ?? "— (unmapped)"}</dd>
                                    <dt>Ghidra</dt><dd>{f().ghidraAddress}</dd>
                                    <dt>Offset</dt><dd>{f().moduleOffset ?? "—"}</dd>
                                    <dt>Calling</dt><dd>{f().callingConvention ?? "—"}</dd>
                                    <Show when={f().mapped}>
                                        <dt>Open</dt>
                                        <dd class="dc-open">
                                            <button class="dc-mini" onClick={() => app.setActiveView("memory")}>Memory</button>
                                            <button class="dc-mini" onClick={() => app.setActiveView("static")}>Disasm</button>
                                        </dd>
                                    </Show>
                                </dl>
                                <div class="dc-pane-head">Pseudocode <span class="dc-warn-inline">Ghidra static decompilation — may be incomplete or incorrect</span></div>
                                <Show when={pseudo()} fallback={<div class="dc-empty small">No pseudocode. Click “Decompile selected function”.</div>}>
                                    {(p) => (
                                        <>
                                            <Show when={p().timedOut}><div class="dc-reason">decompiler timed out — partial or empty output</div></Show>
                                            <Show when={p().truncated}><div class="dc-reason">pseudocode truncated</div></Show>
                                            <Show when={p().found === false}><div class="dc-reason">function not found in analysis</div></Show>
                                            <button class="dc-mini" onClick={() => app.decompiler.clearPseudo(selectedModule()!, f().ghidraAddress)}>clear cache</button>
                                            <pre class="dc-code">{p().cText || "(no decompilation)"}</pre>
                                        </>
                                    )}
                                </Show>
                            </>
                        )}
                    </Show>
                </div>
            </div>
        </div>
    );
}
