import { For, Show, createSignal } from "solid-js";
import { RenameInput } from "../../../ui/RenameInput";
import { useMemory } from "../state/MemoryContext";
import { CppExportModal } from "./CppExportModal";

// Left rail of the memory viewer: the list of class definitions the user has built. Add a new
// one, click to switch the active one, rename via the hover pencil, or remove one (the last
// remaining class stays). Rename is a deliberate button (not double-click) so a click always
// navigates and never gets caught entering an edit field.

export function ClassSidebar() {
    const memory = useMemory();
    const [editingId, setEditingId] = createSignal<string | null>(null);
    const [exportingClass, setExportingClass] = createSignal<typeof memory.classes[number] | undefined>(undefined);

    const commitRename = (id: string, value: string) => {
        memory.renameClass(id, value);
        setEditingId(null);
    };

    return (
        <aside class="class-sidebar">
            <div class="sidebar-head">
                <span class="sidebar-title">CLASSES ({memory.classes.length})</span>
                <button
                    class="sidebar-add"
                    title="export C++ header for active class"
                    onClick={() => setExportingClass(memory.activeClass())}
                    style={{ "font-size": "11px", padding: "1px 5px", margin: "0 2px" }}
                >
                    c++
                </button>
                <button class="sidebar-add" title="new class" onClick={() => memory.addClass()}>
                    +
                </button>
            </div>
            <CppExportModal cls={exportingClass()} onClose={() => setExportingClass(undefined)} />

            <div class="list">
                <For each={memory.classes}>
                    {(c) => (
                        <div
                            class="class-row"
                            classList={{ selected: memory.activeId === c.id }}
                            onClick={() => memory.selectClass(c.id)}
                        >
                            <Show
                                when={editingId() === c.id}
                                fallback={
                                    <>
                                        <span class="grow">{c.name}</span>
                                        <button
                                            class="class-edit"
                                            title="rename class"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                memory.selectClass(c.id);
                                                setEditingId(c.id);
                                            }}
                                        >
                                            ✎
                                        </button>
                                        <Show when={memory.classes.length > 1}>
                                            <button
                                                class="class-del"
                                                title="remove class"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    memory.removeClass(c.id);
                                                }}
                                            >
                                                ✕
                                            </button>
                                        </Show>
                                    </>
                                }
                            >
                                <RenameInput
                                    class="grow class-rename"
                                    value={c.name}
                                    onCommit={(value) => commitRename(c.id, value)}
                                    onCancel={() => setEditingId(null)}
                                />
                            </Show>
                        </div>
                    )}
                </For>
            </div>
        </aside>
    );
}
