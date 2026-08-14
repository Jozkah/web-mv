import { For, Show, createMemo } from "solid-js";
import { useApp } from "../../../app/AppContext";
import { useNavigation } from "../../../app/useNavigation";
import { useStatic } from "../state/StaticContext";
import { Panel } from "../../../ui/Panel";
import { resolveLabel } from "../../../state/labels";
import { outgoingRefs, type XrefKind } from "../state/xref";

// The cross-reference panel: for the selected function, what it references (outgoing - free from
// the current decode) and what references it (incoming - from the accrued xref index, made
// comprehensive by an explicit "Build" over the whole module). Every row jumps through the nav
// coordinator so it lands in the disassembler AND is captured on the back/forward stack.

const KIND_GLYPH: Record<XrefKind, string> = { call: "→", jmp: "⇒", branch: "?", data: "·" };

export function XrefPanel() {
    const { modules } = useApp();
    const nav = useNavigation();
    const { selection, disasm, xref, buildState, buildIndex, cancelBuild } = useStatic();

    const fn = () => selection.selectedFunction();

    const outgoing = createMemo(() => {
        const f = fn();
        if (!f) return [];
        const entry = disasm.get(f.address);
        if (entry?.status !== "ready") return [];
        return outgoingRefs(entry.data.results, modules.list());
    });

    const incoming = createMemo(() => {
        const f = fn();
        return f ? xref.refsTo(f.address) : [];
    });

    const jump = (address: string) => nav.goto("static", address, resolveLabel(address, modules.list()));

    return (
        <Panel
            class="panel-xrefs"
            title="xrefs"
            meta={
                <Show when={fn()} fallback="-">
                    <Show
                        when={buildState().running}
                        fallback={<>{xref.functionsIndexed} fn indexed</>}
                    >
                        indexing {buildState().done}/{buildState().total}
                    </Show>
                </Show>
            }
            actions={
                <Show when={selection.selectedModule()}>
                    {(mod) => (
                        <Show
                            when={buildState().running}
                            fallback={
                                <button
                                    class="xref-build"
                                    title="Decode every function in this module to find all incoming references"
                                    onClick={() => void buildIndex(mod())}
                                >
                                    build index
                                </button>
                            }
                        >
                            <button class="xref-build" onClick={cancelBuild}>
                                cancel
                            </button>
                        </Show>
                    )}
                </Show>
            }
        >
            <div class="panel-body xref-body">
                <Show when={fn()} fallback={<div class="xref-empty">select a function</div>}>
                    <div class="xref-section">
                        <div class="xref-head">Referenced by ({incoming().length})</div>
                        <Show
                            when={incoming().length > 0}
                            fallback={<div class="xref-none">none indexed yet — try “build index”</div>}
                        >
                            <For each={incoming()}>
                                {(site) => (
                                    <button class="xref-row" onClick={() => jump(site.from)} title={site.text}>
                                        <span class="xref-kind" data-kind={site.kind}>{KIND_GLYPH[site.kind]}</span>
                                        <span class="xref-loc">{site.fnName ?? resolveLabel(site.fnAddr, modules.list())}</span>
                                        <span class="xref-at">{site.from}</span>
                                    </button>
                                )}
                            </For>
                        </Show>
                    </div>

                    <div class="xref-section">
                        <div class="xref-head">References ({outgoing().length})</div>
                        <Show when={outgoing().length > 0} fallback={<div class="xref-none">no outgoing refs</div>}>
                            <For each={outgoing()}>
                                {(ref) => (
                                    <button class="xref-row" onClick={() => jump(ref.target)} title={ref.text}>
                                        <span class="xref-kind" data-kind={ref.kind}>{KIND_GLYPH[ref.kind]}</span>
                                        <span class="xref-loc">{ref.label}</span>
                                        <span class="xref-at">{ref.from}</span>
                                    </button>
                                )}
                            </For>
                        </Show>
                    </div>
                </Show>
            </div>
        </Panel>
    );
}
