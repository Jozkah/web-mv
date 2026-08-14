import { For, Show, createEffect, createMemo } from "solid-js";
import { useApp } from "../../app/AppContext";
import { useStatic } from "../static/state/StaticContext";
import { Panel } from "../../ui/Panel";
import { StatusOverlay } from "../../ui/StatusOverlay";
import { calleesOf, sortedFunctions } from "../static/state/analysisXref";
import { functionLabel } from "./label";

// Call graph of the selected function: its direct callees (parsed straight from its own
// disassembly) and its callers (from the whole-module xref index). Clicking any node
// navigates the static view to that function. Callees are cheap; callers require the
// module index to have been built, so the panel offers to build it when missing.

export function CallGraphPanel() {
    const { modules, annotations, setActiveView } = useApp();
    const { selection, functions, disasm, analysis, openAddress } = useStatic();

    const fn = () => selection.selectedFunction();
    const base = () => {
        const f = fn();
        return f ? modules.baseOf(f.module) : undefined;
    };

    // Ensure the selected function's own disassembly is loaded (the Analysis tab can be open
    // without the disassembly panel having fetched it).
    createEffect(() => {
        const f = fn();
        if (f) disasm.ensure(f.address, f.size);
    });

    const moduleFns = () => {
        const f = fn();
        const e = f ? functions.get(f.module) : undefined;
        return e?.status === "ready" ? e.data : [];
    };
    const sorted = createMemo(() => sortedFunctions(moduleFns()));

    const callees = createMemo(() => {
        const f = fn();
        if (!f) return [];
        const e = disasm.get(f.address);
        if (e?.status !== "ready") return [];
        return calleesOf(f.address, e.data.results, sorted());
    });

    const indexReadyForModule = () => {
        const f = fn();
        return analysis.status() === "ready" && analysis.builtModule() === f?.module;
    };

    const callers = createMemo(() => {
        const f = fn();
        const idx = analysis.index();
        if (!f || !idx || !indexReadyForModule()) return [];
        return [...(idx.incoming.get(f.address) ?? [])];
    });

    const nav = (address: string) => {
        openAddress(address);
        setActiveView("static");
    };

    const label = (address: string) => {
        const f = fn();
        const b = base();
        return f && b ? functionLabel(annotations, f.module, b, address) : address;
    };

    const buildIndex = () => {
        const f = fn();
        if (f) analysis.build(f.module, moduleFns());
    };

    return (
        <Panel
            class="ana-panel"
            title="call graph"
            meta={
                <Show when={fn()} fallback="no function selected">
                    {(f) => <>{f().address} · {callees().length} callees · {callers().length} callers</>}
                </Show>
            }
        >
            <div class="panel-body ana-callgraph">
                <Show when={fn()} fallback={<StatusOverlay message="select a function" />}>
                    <div class="ana-cg-section">
                        <div class="ana-cg-head">callees ({callees().length})</div>
                        <Show when={callees().length} fallback={<div class="ana-empty">no direct callees</div>}>
                            <For each={callees()}>
                                {(addr) => (
                                    <button class="ana-node" onClick={() => nav(addr)} title={addr}>
                                        <span class="ana-node-name">{label(addr)}</span>
                                        <span class="addr">{addr}</span>
                                    </button>
                                )}
                            </For>
                        </Show>
                    </div>

                    <div class="ana-cg-section">
                        <div class="ana-cg-head">
                            callers
                            <Show when={indexReadyForModule()}> ({callers().length})</Show>
                        </div>
                        <Show
                            when={indexReadyForModule()}
                            fallback={
                                <div class="ana-index-prompt">
                                    <p class="ana-empty">module index required to resolve callers.</p>
                                    <Show
                                        when={analysis.status() === "building" && analysis.builtModule() === fn()?.module}
                                        fallback={
                                            <button class="ana-build-btn" onClick={buildIndex} disabled={!moduleFns().length}>
                                                build index
                                            </button>
                                        }
                                    >
                                        <span class="ana-progress">
                                            building… {analysis.done()}/{analysis.total()}
                                        </span>
                                        <button class="ana-build-btn" onClick={() => analysis.cancel()}>
                                            cancel
                                        </button>
                                    </Show>
                                </div>
                            }
                        >
                            <Show when={callers().length} fallback={<div class="ana-empty">no callers found</div>}>
                                <For each={callers()}>
                                    {(addr) => (
                                        <button class="ana-node" onClick={() => nav(addr)} title={addr}>
                                            <span class="ana-node-name">{label(addr)}</span>
                                            <span class="addr">{addr}</span>
                                        </button>
                                    )}
                                </For>
                            </Show>
                        </Show>
                    </div>
                </Show>
            </div>
        </Panel>
    );
}
