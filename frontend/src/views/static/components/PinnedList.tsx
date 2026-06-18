import { For, Show } from "solid-js";
import { useApp } from "../../../app/AppContext";
import { useStatic } from "../state/StaticContext";
import { Panel } from "../../../ui/Panel";

// Left rail (bottom): global favorites. Pins span every module; clicking one switches to
// its module and resolves the function (see StaticContext.openPinned).

export function PinnedList() {
    const { annotations } = useApp();
    const { selection, openPinned } = useStatic();

    return (
        <Panel class="panel-pinned" title="pinned" meta={annotations.pinned().length || ""}>
            <Show
                when={annotations.pinned().length > 0}
                fallback={<p class="panel-status">no pinned functions</p>}
            >
                <div class="list">
                    <For each={annotations.pinned()}>
                        {(a) => {
                            const selected = () => {
                                const sel = selection.selectedFunction();
                                return sel?.module === a.module && sel?.rva === a.rva;
                            };
                            return (
                                <div
                                    class="row"
                                    classList={{ selected: selected() }}
                                    onClick={() => openPinned(a.module, a.rva)}
                                >
                                    <span class="grow fn-name">{annotations.nameOf(a.module, a.rva)}</span>
                                    <span class="dim mod" title={a.module}>
                                        {a.module}
                                    </span>
                                </div>
                            );
                        }}
                    </For>
                </div>
            </Show>
        </Panel>
    );
}
