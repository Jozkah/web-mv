import { Show, createEffect, createMemo, onCleanup, onMount } from "solid-js";
import type { EditorView } from "@codemirror/view";
import { useApp } from "../../../app/AppContext";
import { useStatic } from "../state/StaticContext";
import { useNavigation } from "../../../app/useNavigation";
import { parseHex } from "../../../state/address";
import { targetOf } from "../state/xref";
import type { Instruction } from "../../../protocol/types";
import { Panel } from "../../../ui/Panel";
import { StatusOverlay } from "../../../ui/StatusOverlay";
import { buildDoc, createEditor, isComplete, setContent, type OperandLabel } from "./disasm/editor";
import { inferPrototype } from "../state/analysisXref";
import { defaultName } from "../../../state/address";
import { useSigMaker } from "../sigmaker/SigMakerContext";

// Right panel: CodeMirror-backed disassembly of the selected function. Ensures the disasm
// is fetched (cached by address) when the selection changes, and feeds the resulting
// instructions into the editor. CodeMirror handles windowing of huge functions internally.
// The editor host stays mounted at all times (status messages are overlays) so the editor
// view never loses its parent node.

export function DisassemblyView() {
    const { annotations, modules } = useApp();
    const { selection, disasm } = useStatic();
    const nav = useNavigation();
    const sigMaker = useSigMaker();

    // A jumpable operand click records history and navigates to the target (into the containing
    // function for code refs; the owning module for data refs).
    const onLabelClick = (target: string, text: string) => nav.goto("static", target, text);

    // Resolve each instruction's reference target to a display label (custom function name, else
    // `module+0xRVA`) parallel to the doc lines. Reads annotations/modules reactively so a rename
    // re-labels without a re-fetch. Non-referencing instructions get null (no annotation).
    const computeLabels = (instrs: readonly Instruction[]): (OperandLabel | null)[] => {
        const mods = modules.list();
        return instrs.map((instr) => {
            const t = targetOf(instr, mods);
            if (!t) return null;
            const a = parseHex(t.target);
            for (const m of mods) {
                const base = parseHex(m.base);
                if (a >= base && a < base + BigInt(m.size)) {
                    const rva = "0x" + (a - base).toString(16);
                    const text = annotations.hasCustomName(m.name, rva) ? annotations.nameOf(m.name, rva) : `${m.name}+${rva}`;
                    return { text, target: t.target, navigable: true };
                }
            }
            return { text: t.target, target: t.target, navigable: false };
        });
    };

    const entry = () => {
        const fn = selection.selectedFunction();
        return fn ? disasm.get(fn.address) : undefined;
    };
    const ready = () => {
        const e = entry();
        return e?.status === "ready" ? e.data : undefined;
    };
    const errorMsg = () => {
        const e = entry();
        return e?.status === "error" ? e.error : undefined;
    };

    // Fetch-once on selection change.
    createEffect(() => {
        const fn = selection.selectedFunction();
        if (fn) disasm.ensure(fn.address, fn.size);
    });

    let host: HTMLDivElement | undefined;
    let view: EditorView | undefined;

    onMount(() => {
        const results = ready()?.results ?? [];
        view = createEditor(host!, buildDoc(results), computeLabels(results), onLabelClick);
    });
    onCleanup(() => view?.destroy());

    // Push instructions + operand labels into the editor whenever the ready data (or an
    // annotation feeding the labels) changes; empty while loading, errored, or nothing selected.
    createEffect(() => {
        const results = ready()?.results ?? [];
        if (view) setContent(view, buildDoc(results), computeLabels(results));
    });

    const title = () => {
        const fn = selection.selectedFunction();
        return fn?.module && fn?.rva ? annotations.nameOf(fn.module, fn.rva) : null;
    };

    // Heuristic prototype guessed from the disassembly (arg registers read before written,
    // rax as a return value, prologue frame size). A best-effort hint, not ground truth.
    const prototype = createMemo(() => {
        const data = ready();
        const fn = selection.selectedFunction();
        if (!data || !fn) return undefined;
        const name = title() || defaultName(fn.rva);
        return inferPrototype(name, data.results);
    });

    return (
        <>
            <Panel
                class="panel-disasm"
                title="disassembly"
                meta={
                    <Show when={selection.selectedFunction()} fallback="-">
                        {(fn) => (
                            <>
                                {title()} · {fn().address}
                                <Show when={ready()}>
                                    {(d) => (
                                        <>
                                            {" "}· {d().count} instructions
                                            <Show when={!isComplete(d().address, fn().size, d().results)}>
                                                {" "}· <span class="warn">truncated</span>
                                            </Show>
                                        </>
                                    )}
                                </Show>
                                <Show when={entry()?.status === "loading"}> · disassembling…</Show>
                            </>
                        )}
                    </Show>
                }
                actions={
                    <Show when={selection.selectedFunction() && ready()?.results.length}>
                        <button
                            onClick={() => {
                                const fn = selection.selectedFunction();
                                const d = ready();
                                if (!fn || !d) return;
                                sigMaker.open({
                                    moduleName: fn.module,
                                    functionName: title() || undefined,
                                    address: fn.address,
                                    size: fn.size,
                                    source: "code",
                                    instructions: d.results,
                                });
                            }}
                            title="Open IDA SigMaker for this function"
                            style={{ font: "inherit", "font-size": "12px", cursor: "pointer", padding: "2px 8px" }}
                        >
                            sigmaker
                        </button>
                    </Show>
                }
            >
                <Show when={prototype()}>
                    {(proto) => (
                        <div class="disasm-prototype" title="heuristic prototype inferred from the disassembly">
                            <span class="disasm-proto-sig">{proto().signature}</span>
                            <Show when={proto().frameSize > 0}>
                                <span class="disasm-proto-frame">frame 0x{proto().frameSize.toString(16)}</span>
                            </Show>
                        </div>
                    )}
                </Show>
                <div class="panel-body">
                    <div ref={host} class="disasm-host" />
                    <StatusOverlay message={!selection.selectedFunction() && "select a function to disassemble"} />
                    <StatusOverlay message={errorMsg()} error />
                </div>
            </Panel>
        </>
    );
}

