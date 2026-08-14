import { For, Show, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { useNavigation } from "../../app/useNavigation";
import { scanNew, scanFilter, scanClear } from "../../protocol/requests";
import { resolveLabel } from "../../state/labels";
import { errorText } from "../../state/errors";
import { SCAN_TYPES, valueToBits } from "../../state/scanValue";
import { useNextScanHotkey } from "../../scan/useNextScanHotkey";
import type { ScanHit, ScanValueType, ScanFilterOp } from "../../protocol/types";
import "../pe/pe.css";
import "./scanner.css";

// Cheat-Engine-style value scanner. First Scan sweeps a module for an exact value; each Next Scan
// narrows the survivors by an operator (unchanged / changed / increased / decreased, or a new
// comparison value). Backed by the ext agent's scan_new / scan_filter / scan_clear verbs, which
// hold the full candidate set; the view shows a bounded sample and the running count.

const DIFF_OPS: { op: ScanFilterOp; label: string }[] = [
    { op: "unchanged", label: "Unchanged" },
    { op: "changed", label: "Changed" },
    { op: "increased", label: "Increased" },
    { op: "decreased", label: "Decreased" },
];
const CMP_OPS: { op: ScanFilterOp; label: string }[] = [
    { op: "eq", label: "= value" },
    { op: "gt", label: "> value" },
    { op: "lt", label: "< value" },
];

export function ScannerView() {
    const { attached, modules, client, cheat } = useApp();
    const nav = useNavigation();

    const [value, setValue] = createSignal("");
    const [type, setType] = createSignal<ScanValueType>("i32");
    const [module, setModule] = createSignal("");
    const [scope, setScope] = createSignal<"module" | "process">("module");
    const [hits, setHits] = createSignal<ScanHit[]>([]);
    const [count, setCount] = createSignal(0);
    const [scanning, setScanning] = createSignal(false);
    const [started, setStarted] = createSignal(false);
    const [error, setError] = createSignal<string>();

    const apply = (r: { count: number; results: ScanHit[] }) => {
        setCount(r.count);
        setHits(r.results);
    };

    const firstScan = async () => {
        const bits = valueToBits(value(), type());
        if (!bits) { setError(`invalid ${type()} value`); return; }
        setError(undefined);
        setScanning(true);
        try {
            const r = await scanNew(client, {
                scope: scope(),
                module: scope() === "module" ? module() || undefined : undefined,
                value_type: type(),
                value_hex: bits,
            });
            apply(r);
            setStarted(true);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setScanning(false);
        }
    };

    const nextScan = async (op: ScanFilterOp) => {
        setError(undefined);
        setScanning(true);
        try {
            let value_hex: string | undefined;
            if (op === "eq" || op === "gt" || op === "lt") {
                value_hex = valueToBits(value(), type());
                if (!value_hex) { setError(`invalid ${type()} value`); setScanning(false); return; }
            }
            const r = await scanFilter(client, { op, value_hex });
            apply(r);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setScanning(false);
        }
    };

    // Global Ctrl+Enter runs the next filter pass (equality) once a scan is under way, so a user
    // can iterate value -> next-scan without keeping the value box focused.
    useNextScanHotkey(() => { void nextScan("eq"); }, { enabled: () => started() && !scanning() });

    const newScan = async () => {
        try { await scanClear(client); } catch { /* best effort */ }
        setStarted(false);
        setHits([]);
        setCount(0);
        setError(undefined);
    };

    const label = (addr: string) => resolveLabel(addr, modules.list());

    return (
        <div class="pe-view">
            <div class="pe-toolbar">
                <input
                    class="pe-input sc-value"
                    placeholder="value"
                    value={value()}
                    onInput={(e) => setValue(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && (started() ? nextScan("eq") : firstScan())}
                />
                <select class="pe-input" value={type()} onChange={(e) => setType(e.currentTarget.value as ScanValueType)}>
                    <For each={SCAN_TYPES}>{(t) => <option value={t.key}>{t.label}</option>}</For>
                </select>
                <select class="pe-input" value={scope()} onChange={(e) => setScope(e.currentTarget.value as "module" | "process")} disabled={started()} title="Where to search">
                    <option value="module">module</option>
                    <option value="process">whole process (heap)</option>
                </select>
                <select class="pe-input" value={module()} onChange={(e) => setModule(e.currentTarget.value)} disabled={started() || scope() === "process"}>
                    <option value="">(main module)</option>
                    <For each={modules.list()}>{(m) => <option value={m.name}>{m.name}</option>}</For>
                </select>
                <Show
                    when={started()}
                    fallback={
                        <button class="pe-btn sc-primary" onClick={firstScan} disabled={!attached() || scanning()}>
                            {scanning() ? "scanning…" : "First Scan"}
                        </button>
                    }
                >
                    <button class="pe-btn" onClick={newScan} disabled={scanning()}>New Scan</button>
                </Show>
                <span class="pe-note">{count().toLocaleString()} found</span>
                <Show when={!attached()}><span class="pe-warn">agent not attached</span></Show>
                <Show when={error()}><span class="pe-warn">{error()}</span></Show>
            </div>

            <Show when={started()}>
                <div class="sc-filterbar">
                    <For each={DIFF_OPS}>
                        {(f) => (
                            <button class="pe-btn small" onClick={() => nextScan(f.op)} disabled={scanning()}>
                                {f.label}
                            </button>
                        )}
                    </For>
                    <span class="sc-sep" />
                    <For each={CMP_OPS}>
                        {(f) => (
                            <button class="pe-btn small" onClick={() => nextScan(f.op)} disabled={scanning()} title="uses the value box above">
                                {f.label}
                            </button>
                        )}
                    </For>
                </div>
            </Show>

            <div class="sc-body">
                <Show when={hits().length > 0} fallback={<div class="rg-empty">{started() ? "no matches — narrow with a Next Scan" : "enter a value and First Scan"}</div>}>
                    <table class="pe-table sc-table">
                        <thead>
                            <tr><th>Address</th><th>Label</th><th>Value</th><th class="sc-act-col">Actions</th></tr>
                        </thead>
                        <tbody>
                            <For each={hits()}>
                                {(h) => (
                                    <tr>
                                        <td class="mono">{h.address}</td>
                                        <td class="mono dim">{label(h.address)}</td>
                                        <td class="mono">{h.value}</td>
                                        <td class="sc-act">
                                            <button title="Add to cheat table" onClick={() => { const vt = type(); cheat.add(h.address, vt === "unknown" ? "u32" : vt, ""); }}>➕</button>
                                            <button title="Open in memory viewer" onClick={() => nav.goto("memory", h.address, label(h.address))}>🧠</button>
                                            <button title="Open in disassembler" onClick={() => nav.goto("static", h.address, label(h.address))}>⚡</button>
                                        </td>
                                    </tr>
                                )}
                            </For>
                        </tbody>
                    </table>
                    <Show when={count() > hits().length}>
                        <div class="sc-more">showing first {hits().length} of {count().toLocaleString()} — narrow further to see them all</div>
                    </Show>
                </Show>
            </div>
        </div>
    );
}
