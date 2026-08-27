import { For, Show, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import type { ProjectComparison } from "../../project/projectBundle";
import "./project.css";

// Project database: export the whole per-target workspace (watches, patches, cheat) as one versioned
// bundle, import one back (inert — nothing is applied to the live process), or compare two projects.

export function ProjectView() {
    const app = useApp();
    const [msg, setMsg] = createSignal<string>();
    const [cmp, setCmp] = createSignal<ProjectComparison>();

    const doExport = () => {
        const blob = new Blob([app.project.exportJSON()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `project-${new Date().toISOString().replace(/[:.]/g, "-")}.json`; a.click();
        URL.revokeObjectURL(url);
    };
    const doImport = (f: File) => f.text().then((t) => {
        try { const r = app.project.importJSON(t); setMsg(`Imported ${r.watches} watches, ${r.patches} patches, ${r.cheat} cheat entries (loaded inert — nothing applied).`); setCmp(undefined); }
        catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    });
    const doCompare = (f: File) => f.text().then((t) => {
        try { const { comparison } = app.project.compareWith(t); setCmp(comparison); setMsg(undefined); }
        catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    });

    const fp = () => app.project.snapshot().target;

    return (
        <div class="proj-view">
            <div class="proj-toolbar">
                <button class="proj-btn" onClick={doExport}>Export project</button>
                <label class="proj-btn">Import<input type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) doImport(f); e.currentTarget.value = ""; }} /></label>
                <label class="proj-btn">Compare with…<input type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) doCompare(f); e.currentTarget.value = ""; }} /></label>
                <span class="proj-fp" title="Current target fingerprint">target: {fp().name ?? fp().key}{fp().pid !== undefined ? ` · pid ${fp().pid}` : ""}</span>
            </div>

            <Show when={msg()}><div class="proj-banner">{msg()}</div></Show>

            <Show when={cmp()}>
                {(c) => (
                    <div class="proj-compare">
                        <div class="proj-section-head">Comparison</div>
                        <div class="proj-row"><span>Target identity</span><b class={c().targetMatch ? "ok" : "warn"}>{c().targetMatch ? "same process" : "different process"}</b></div>
                        <DiffBlock title="Patches" d={c().patches} />
                        <Show when={c().patchByteChanges.length > 0}>
                            <div class="proj-row"><span>Patch byte changes</span><b class="warn">{c().patchByteChanges.length}</b></div>
                            <div class="proj-list"><For each={c().patchByteChanges}>{(s) => <div class="proj-item">{s}</div>}</For></div>
                        </Show>
                        <DiffBlock title="Watches" d={c().watches} />
                    </div>
                )}
            </Show>

            <p class="proj-note">Importing a project loads its watches and patches DISABLED/pending — the workspace never auto-applies saved writes or patches to a newly attached process. Applying requires an explicit, identity-matched action.</p>
        </div>
    );
}

function DiffBlock(props: { title: string; d: { onlyA: string[]; onlyB: string[]; common: string[] } }) {
    return (
        <div class="proj-diff">
            <div class="proj-section-head">{props.title}</div>
            <div class="proj-row"><span>Only in this project</span><b>{props.d.onlyA.length}</b></div>
            <div class="proj-row"><span>Only in the other</span><b>{props.d.onlyB.length}</b></div>
            <div class="proj-row"><span>In both</span><b>{props.d.common.length}</b></div>
        </div>
    );
}
