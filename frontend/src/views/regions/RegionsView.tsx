import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { useNavigation } from "../../app/useNavigation";
import { regions as fetchRegions } from "../../protocol/requests";
import { resolveLabel } from "../../state/labels";
import { errorText } from "../../state/errors";
import { ModulePicker } from "../../scan/ModulePicker";
import type { RegionEntry } from "../../protocol/types";
import "../pe/pe.css";
import "./regions.css";

// Memory-map view: the live region map from the ext agent's `regions` verb (virtual_query walk).
// Unlike the PE `sections` table (static image metadata), these are the process's actual committed
// regions with real protection flags - the basis for scan-scoping and for spotting heaps/stacks.
// Rows jump into the disassembler (executable regions) or ReClass, recording nav on the way.

// MEM_* state / type constants → short labels.
function stateLabel(s: number): string {
    if (s === 0x1000) return "commit";
    if (s === 0x2000) return "reserve";
    return "0x" + s.toString(16);
}
function typeLabel(t: number): string {
    if (t === 0x1000000) return "image";
    if (t === 0x40000) return "mapped";
    if (t === 0x20000) return "private";
    return t === 0 ? "—" : "0x" + t.toString(16);
}

const PROT_FILTERS = [
    { key: "all", label: "all" },
    { key: "x", label: "executable" },
    { key: "w", label: "writable" },
    { key: "image", label: "image" },
] as const;
type ProtFilterKey = (typeof PROT_FILTERS)[number]["key"];

export function RegionsView() {
    const { client, attached, modules } = useApp();
    const nav = useNavigation();

    const [selected, setSelected] = createSignal("");
    const [rows, setRows] = createSignal<RegionEntry[]>();
    const [error, setError] = createSignal<string>();
    const [loading, setLoading] = createSignal(false);
    const [filter, setFilter] = createSignal<ProtFilterKey>("all");
    let seq = 0;

    const load = async () => {
        const mine = ++seq;
        setLoading(true);
        setError(undefined);
        try {
            const r = await fetchRegions(client, selected() ? { module: selected() } : {});
            if (mine === seq) setRows(r.results);
        } catch (e) {
            if (mine === seq) setError(errorText(e));
        } finally {
            if (mine === seq) setLoading(false);
        }
    };

    const filtered = createMemo(() => {
        const all = rows();
        if (!all) return undefined;
        switch (filter()) {
            case "x":
                return all.filter((r) => r.prot.includes("x"));
            case "w":
                return all.filter((r) => r.prot.includes("w"));
            case "image":
                return all.filter((r) => r.type === 0x1000000);
            default:
                return all;
        }
    });

    const totalBytes = createMemo(() => (filtered() ?? []).reduce((sum, r) => sum + r.size, 0));

    const toMemory = (address: string) => nav.goto("memory", address, resolveLabel(address, modules.list()));
    const toDisasm = (address: string) => nav.goto("static", address, resolveLabel(address, modules.list()));

    return (
        <div class="pe-view">
            <div class="pe-toolbar">
                <ModulePicker value={selected()} onChange={setSelected} emptyLabel="(whole address space)" />
                <button class="pe-btn" onClick={load} disabled={!attached() || loading()}>
                    {loading() ? "…" : "↻ Map"}
                </button>
                <div class="rg-filters">
                    <For each={PROT_FILTERS}>
                        {(f) => (
                            <button
                                class="rg-filter"
                                classList={{ active: filter() === f.key }}
                                onClick={() => setFilter(f.key)}
                            >
                                {f.label}
                            </button>
                        )}
                    </For>
                </div>
                <Show when={filtered()}>
                    {(f) => (
                        <span class="pe-note">
                            {f().length} regions · {(totalBytes() / (1024 * 1024)).toFixed(1)} MB
                        </span>
                    )}
                </Show>
                <Show when={!attached()}><span class="pe-warn">agent not attached</span></Show>
                <Show when={error()}><span class="pe-warn">{error()}</span></Show>
            </div>

            <div class="rg-body">
                <Show when={filtered()} fallback={<div class="rg-empty">Click “Map” to walk the address space.</div>}>
                    {(f) => (
                        <table class="pe-table rg-table">
                            <thead>
                                <tr>
                                    <th>Base</th>
                                    <th>Module</th>
                                    <th>Size</th>
                                    <th>Prot</th>
                                    <th>State</th>
                                    <th>Type</th>
                                    <th class="rg-jump-col">Jump</th>
                                </tr>
                            </thead>
                            <tbody>
                                <For each={f()}>
                                    {(r) => {
                                        const label = resolveLabel(r.base, modules.list());
                                        const mod = label === r.base ? "" : label.split("+")[0];
                                        return (
                                            <tr classList={{ "rg-exec": r.prot.includes("x") }}>
                                                <td class="mono">{r.base}</td>
                                                <td class="mono dim">{mod || <span class="dim">—</span>}</td>
                                                <td class="mono">{(r.size / 1024).toFixed(0)} KB</td>
                                                <td class="mono prot">{r.prot}</td>
                                                <td class="mono dim">{stateLabel(r.state)}</td>
                                                <td class="mono dim">{typeLabel(r.type)}</td>
                                                <td class="rg-jump">
                                                    <button title="Open in memory viewer" onClick={() => toMemory(r.base)}>🧠</button>
                                                    <Show when={r.prot.includes("x")}>
                                                        <button title="Open in disassembler" onClick={() => toDisasm(r.base)}>⚡</button>
                                                    </Show>
                                                </td>
                                            </tr>
                                        );
                                    }}
                                </For>
                            </tbody>
                        </table>
                    )}
                </Show>
            </div>
        </div>
    );
}
