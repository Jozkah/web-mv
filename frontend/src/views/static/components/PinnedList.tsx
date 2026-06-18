import { For, Show, createSignal } from "solid-js";
import { useApp } from "../../../app/AppContext";
import { useStatic } from "../state/StaticContext";
import { Panel } from "../../../ui/Panel";
import { RenameInput } from "../../../ui/RenameInput";

// Left rail (bottom): global favorites. Pins span every module; clicking one switches to
// its module and resolves the function (see StaticContext.openPinned). Hover a row for the
// rename pen (deliberate button, not a click on the name, so a click always navigates) and
// the remove button, which just unpins - the function and any custom name are untouched.

export function PinnedList() {
    const { annotations } = useApp();
    const { selection, openPinned } = useStatic();
    const [editing, setEditing] = createSignal<string | null>(null); // "module@rva" under rename

    const keyOf = (module: string, rva: string) => `${module}@${rva}`;
    const commitRename = (module: string, rva: string, value: string) => {
        annotations.rename(module, rva, value);
        setEditing(null);
    };

    return (
        <Panel class="panel-pinned" title="pinned" meta={annotations.pinned().length || ""}>
            <Show
                when={annotations.pinned().length > 0}
                fallback={<p class="panel-status">no pinned functions</p>}
            >
                <div class="list">
                    <For each={annotations.pinned()}>
                        {(a) => {
                            const key = keyOf(a.module, a.rva);
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
                                    <Show
                                        when={editing() === key}
                                        fallback={
                                            <>
                                                <span class="grow fn-name">
                                                    {annotations.nameOf(a.module, a.rva)}
                                                </span>
                                                <span class="dim mod" title={a.module}>
                                                    {a.module}
                                                </span>
                                                <button
                                                    class="pin-edit"
                                                    title="rename function"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setEditing(key);
                                                    }}
                                                >
                                                    ✎
                                                </button>
                                                <button
                                                    class="pin-del"
                                                    title="remove pin"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        annotations.togglePin(a.module, a.rva);
                                                    }}
                                                >
                                                    ✕
                                                </button>
                                            </>
                                        }
                                    >
                                        <RenameInput
                                            class="grow rename"
                                            value={annotations.nameOf(a.module, a.rva)}
                                            onCommit={(value) => commitRename(a.module, a.rva, value)}
                                            onCancel={() => setEditing(null)}
                                        />
                                    </Show>
                                </div>
                            );
                        }}
                    </For>
                </div>
            </Show>
        </Panel>
    );
}
