import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { byteDiff, hexLen, nopFill, normalizeHex } from "../../patch/patchOps";
import "./patch.css";

// Safe patch workspace. Raw bytes only (no assembler). Originals are always captured before the
// first apply, so every patch is reversible. Saved patches load disabled — applying is explicit and
// confirmed (old vs new bytes shown). Overlapping applied patches are flagged as conflicts.

const AVAIL: Record<string, { text: string; tone: string; detail: string }> = {
    available: { text: "Write ready", tone: "live", detail: "patch.rawBytes confirmed" },
    assumed: { text: "Write (assumed)", tone: "warn", detail: "capability assumed, not confirmed" },
    unavailable: { text: "Write unavailable", tone: "danger", detail: "Connect the extension agent (web_mv_ext_agent.as) — patches use the write verb." },
};

export function PatchView() {
    const app = useApp();
    const p = app.patches;

    const [expr, setExpr] = createSignal("");
    const [bytes, setBytes] = createSignal("");
    const [nopLen, setNopLen] = createSignal(1);
    const [msg, setMsg] = createSignal<string>();

    const avail = () => AVAIL[p.availability()];
    const conflicts = createMemo(() => p.conflicts());

    const addPatch = () => {
        setMsg(undefined);
        const e = expr().trim();
        const b = normalizeHex(bytes());
        if (!e || !b) { setMsg("Enter an address and valid hex bytes"); return; }
        try {
            p.add({ expression: e, patchedBytes: b });
            setExpr(""); setBytes("");
        } catch (err) {
            setMsg(err instanceof Error ? err.message : String(err));
        }
    };

    const confirmApply = async (id: string) => {
        const def = p.byId(id);
        if (!def) return;
        const addr = p.runtime(id).resolvedAddress ?? p.resolveAddr(def) ?? "?";
        const orig = def.originalBytes ?? "(will be read from target)";
        const ok = window.confirm(`Apply patch "${def.name}" at ${addr}?\n\nThis writes to live process memory.\nOriginal: ${orig}\nPatched:  ${def.patchedBytes}`);
        if (!ok) return;
        const err = await p.apply(id);
        if (err) setMsg(err);
    };

    const doExport = () => {
        const blob = new Blob([p.exportJSON()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `patches-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; a.click();
        URL.revokeObjectURL(url);
    };
    const doImport = (file: File) => file.text().then((t) => { try { p.importJSON(t); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } });

    return (
        <div class="patch-view">
            <div class="patch-toolbar">
                <input class="patch-input" placeholder="Address, e.g. game.exe+0x1234 or 0x14000abcd" value={expr()} onInput={(e) => setExpr(e.currentTarget.value)} />
                <input class="patch-input patch-bytes" placeholder="Patched bytes (hex, e.g. 90 90 90)" value={bytes()} onInput={(e) => setBytes(e.currentTarget.value)} />
                <span class="patch-field">NOP <input class="patch-num" type="number" min="1" value={nopLen()} onInput={(e) => setNopLen(Number(e.currentTarget.value))} />
                    <button class="patch-btn sm" onClick={() => setBytes(nopFill(nopLen()))} title="Fill with NOP (0x90) bytes">fill</button>
                </span>
                <button class="patch-btn" onClick={addPatch}>+ Patch</button>
                <div class="patch-spacer" />
                <span class={`patch-avail tone-${avail().tone}`} title={avail().detail}>{avail().text}</span>
                <button class="patch-btn" onClick={() => p.restoreAll()} title="Restore originals for every applied patch">Restore all</button>
                <button class="patch-btn" onClick={doExport}>Export</button>
                <label class="patch-btn" title="Import patch set (loads disabled)">Import
                    <input type="file" accept="application/json,.json" style={{ display: "none" }} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) doImport(f); e.currentTarget.value = ""; }} />
                </label>
            </div>
            <Show when={msg()}><div class="patch-banner">{msg()}</div></Show>
            <Show when={p.availability() === "unavailable"}><div class="patch-banner danger">{avail().detail}</div></Show>

            <div class="patch-table">
                <div class="patch-thead">
                    <span /><span>Name</span><span>Address</span><span>Original</span><span>Patched</span><span>Status</span><span>Actions</span>
                </div>
                <div class="patch-tbody">
                    <Show when={p.patches().length > 0} fallback={<div class="patch-empty">No patches. Add an address + bytes above, or use “Add to patch workspace” from an address elsewhere.</div>}>
                        <For each={p.patches()}>
                            {(def) => {
                                const rt = () => p.runtime(def.id);
                                const conflict = () => conflicts().has(def.id);
                                const diff = () => (def.originalBytes ? byteDiff(def.originalBytes, def.patchedBytes).length : hexLen(def.patchedBytes));
                                return (
                                    <div class="patch-row" classList={{ applied: rt().status === "applied", stale: rt().status === "stale", conflict: conflict() }}>
                                        <span>
                                            <input type="checkbox" checked={rt().status === "applied"} aria-label={`Apply ${def.name}`}
                                                disabled={p.availability() === "unavailable" || !app.attached()}
                                                onChange={(e) => { if (e.currentTarget.checked) confirmApply(def.id); else p.setEnabled(def.id, false); }} />
                                        </span>
                                        <span class="patch-name" title={def.name}>{def.name}</span>
                                        <span class="patch-addr" title={def.expression}>{def.module ? `${def.module}+${def.rva}` : def.expression}</span>
                                        <span class="patch-mono dim">{def.originalBytes ?? "—"}</span>
                                        <span class="patch-mono">{def.patchedBytes} <span class="patch-diff">({diff()}∆)</span></span>
                                        <span class="patch-status">
                                            {rt().status}
                                            <Show when={conflict()}><span class="patch-warn" title="Overlaps another applied patch"> ⚠ conflict</span></Show>
                                            <Show when={rt().error}><span class="patch-warn"> {rt().error}</span></Show>
                                        </span>
                                        <span class="patch-actions">
                                            <button class="patch-btn sm" disabled={!def.originalBytes} onClick={() => p.restore(def.id)} title="Restore original bytes">Restore</button>
                                            <button class="patch-btn sm danger" onClick={() => p.remove(def.id)}>✕</button>
                                        </span>
                                    </div>
                                );
                            }}
                        </For>
                    </Show>
                </div>
            </div>
            <p class="patch-note">Patches write raw bytes through the Angel write verb; the original bytes are always retained and restored on demand. No assembler, code caves, allocation, or protection changes (unavailable Angel primitives). A target change marks applied patches stale — re-apply explicitly.</p>
        </div>
    );
}
