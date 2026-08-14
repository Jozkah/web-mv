import { For, Show, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { useNavigation } from "../../app/useNavigation";
import { resolveLabel } from "../../state/labels";
import { downloadText, pickTextFile } from "../../state/fileio";
import { errorText } from "../../state/errors";
import "./bookmarks.css";

// Bookmarks view. The persisted list lives in the shared bookmarks store (so other views can pin
// addresses here); this view renders it and provides jump-to-memory / jump-to-disasm navigation.

export function BookmarksView() {
    const { modules, bookmarks } = useApp();
    const nav = useNavigation();

    const [addrInput, setAddrInput] = createSignal("");
    const [labelInput, setLabelInput] = createSignal("");
    const [noteInput, setNoteInput] = createSignal("");
    const [importMsg, setImportMsg] = createSignal<string>();

    const add = () => {
        const id = bookmarks.add(addrInput(), labelInput(), noteInput());
        if (id === undefined) return; // invalid address
        setAddrInput("");
        setLabelInput("");
        setNoteInput("");
    };

    const doImport = async () => {
        const text = await pickTextFile();
        if (text === undefined) return;
        try {
            const n = bookmarks.importJson(text);
            setImportMsg(n > 0 ? `imported ${n}` : "no valid bookmarks in file");
        } catch (err) {
            setImportMsg(errorText(err));
        }
    };

    const toMemory = (addr: string) => nav.goto("memory", addr, resolveLabel(addr, modules.list()));
    const toDisasm = (addr: string) => nav.goto("static", addr, resolveLabel(addr, modules.list()));

    return (
        <div class="bm-view">
            <div class="bm-toolbar">
                <input
                    class="bm-input bm-addr"
                    placeholder="address (0x...)"
                    value={addrInput()}
                    onInput={(e) => setAddrInput(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                />
                <input
                    class="bm-input bm-label"
                    placeholder="label"
                    value={labelInput()}
                    onInput={(e) => setLabelInput(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                />
                <input
                    class="bm-input bm-note"
                    placeholder="note"
                    value={noteInput()}
                    onInput={(e) => setNoteInput(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && add()}
                />
                <button class="bm-btn" onClick={add}>+ Add</button>
                <button class="bm-btn ghost" title="Export bookmarks to JSON" onClick={() => downloadText("bookmarks.json", bookmarks.exportJson())}>⭳</button>
                <button class="bm-btn ghost" title="Import bookmarks from JSON" onClick={doImport}>⭱</button>
                <Show when={importMsg()}><span class="bm-rva">{importMsg()}</span></Show>
            </div>

            <Show
                when={bookmarks.items.length > 0}
                fallback={<div class="bm-empty">No bookmarks yet. Add an address above, or use “→ Bookmark” from another view.</div>}
            >
                <table class="bm-table">
                    <thead>
                        <tr>
                            <th>Label</th>
                            <th>Address</th>
                            <th>Note</th>
                            <th class="bm-actions-col">Jump</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        <For each={bookmarks.items}>
                            {(b) => (
                                <tr>
                                    <td>{b.label || <span class="muted">—</span>}</td>
                                    <td class="mono">
                                        <div>{b.address}</div>
                                        <div class="bm-rva">{resolveLabel(b.address, modules.list())}</div>
                                    </td>
                                    <td class="bm-note-cell">{b.note}</td>
                                    <td class="bm-actions">
                                        <button class="bm-btn small" title="Open in memory viewer" onClick={() => toMemory(b.address)}>🧠</button>
                                        <button class="bm-btn small" title="Open in disassembler" onClick={() => toDisasm(b.address)}>⚡</button>
                                    </td>
                                    <td>
                                        <button class="bm-btn ghost" title="Remove" onClick={() => bookmarks.remove(b.id)}>×</button>
                                    </td>
                                </tr>
                            )}
                        </For>
                    </tbody>
                </table>
            </Show>
        </div>
    );
}
