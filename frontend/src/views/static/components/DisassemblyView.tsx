import { Show, createEffect, onCleanup, onMount } from "solid-js";
import type { EditorView } from "@codemirror/view";
import { useApp } from "../../../app/AppContext";
import { useStatic } from "../state/StaticContext";
import { Panel } from "../../../ui/Panel";
import { StatusOverlay } from "../../../ui/StatusOverlay";
import { buildDoc, createEditor, isComplete, setDoc } from "./disasm/editor";

// Right panel: CodeMirror-backed disassembly of the selected function. Ensures the disasm
// is fetched (cached by address) when the selection changes, and feeds the resulting
// instructions into the editor. CodeMirror handles windowing of huge functions internally.
// The editor host stays mounted at all times (status messages are overlays) so the editor
// view never loses its parent node.

export function DisassemblyView() {
    const { annotations } = useApp();
    const { selection, disasm } = useStatic();

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
        const data = ready();
        view = createEditor(host!, data ? buildDoc(data.results) : "");
    });
    onCleanup(() => view?.destroy());

    // Push instructions into the editor whenever the ready data changes (empty while
    // loading, errored, or nothing selected).
    createEffect(() => {
        const data = ready();
        if (view) setDoc(view, data ? buildDoc(data.results) : "");
    });

    const title = () => {
        const fn = selection.selectedFunction();
        return fn ? annotations.nameOf(fn.module, fn.rva) : null;
    };

    return (
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
        >
            <div class="panel-body">
                <div ref={host} class="disasm-host" />
                <StatusOverlay message={!selection.selectedFunction() && "select a function to disassemble"} />
                <StatusOverlay message={errorMsg()} error />
            </div>
        </Panel>
    );
}
