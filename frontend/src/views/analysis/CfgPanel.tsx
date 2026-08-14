import { For, Show, createEffect, createMemo } from "solid-js";
import { useStatic } from "../static/state/StaticContext";
import { Panel } from "../../ui/Panel";
import { StatusOverlay } from "../../ui/StatusOverlay";
import { splitBasicBlocks } from "../static/state/analysisXref";

// Per-function control-flow graph: the selected function's instructions split into basic
// blocks, each shown as a box listing its instructions and the block ids it flows to. A
// linear (dominator-order) block listing rather than a full 2D layout - enough to read the
// branching structure without a graph-layout engine.

export function CfgPanel() {
    const { openAddress, selection, disasm } = useStatic();

    const fn = () => selection.selectedFunction();

    createEffect(() => {
        const f = fn();
        if (f) disasm.ensure(f.address, f.size);
    });

    const blocks = createMemo(() => {
        const f = fn();
        if (!f) return [];
        const e = disasm.get(f.address);
        if (e?.status !== "ready") return [];
        return splitBasicBlocks(e.data.results);
    });

    return (
        <Panel
            class="ana-panel"
            title="control-flow graph"
            meta={
                <Show when={fn()} fallback="no function selected">
                    {blocks().length} blocks
                </Show>
            }
        >
            <div class="panel-body ana-cfg">
                <Show
                    when={fn() && blocks().length}
                    fallback={<StatusOverlay message={fn() ? "disassembling…" : "select a function"} />}
                >
                    <For each={blocks()}>
                        {(block) => (
                            <div class="ana-block">
                                <button
                                    class="ana-block-head"
                                    onClick={() => openAddress(block.start)}
                                    title="jump to this block in the disassembly"
                                >
                                    <span class="ana-block-id">B{block.id}</span>
                                    <span class="addr">{block.start}</span>
                                    <span class="dim">{block.instructions.length} ins</span>
                                </button>
                                <div class="ana-block-body">
                                    <For each={block.instructions}>
                                        {(ins) => (
                                            <div class="ana-ins">
                                                <span class="addr">{ins.address}</span>
                                                <span class="ana-ins-text">{ins.text}</span>
                                            </div>
                                        )}
                                    </For>
                                </div>
                                <Show when={block.successors.length}>
                                    <div class="ana-block-edges">
                                        →{" "}
                                        <For each={block.successors}>
                                            {(s, i) => (
                                                <>
                                                    <Show when={i() > 0}>, </Show>
                                                    <span class="ana-edge">B{s}</span>
                                                </>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                            </div>
                        )}
                    </For>
                </Show>
            </div>
        </Panel>
    );
}
