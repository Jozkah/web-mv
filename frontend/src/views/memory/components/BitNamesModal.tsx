import { createSignal, Show } from "solid-js";
import { Window } from "../../../ui/Window";
import { NODE_TYPES, type Node } from "../nodes/types";

// Editor for a bitfield node's named bits: one name per line, top line = bit 0. Blank lines
// leave that bit unnamed. Saved onto the node (persisted with the class) and rendered next to
// the binary value ("0101 [FLAG_A|FLAG_C]").

export function BitNamesModal(props: {
    node: Node | undefined;
    onSave: (names: string[]) => void;
    onClose: () => void;
}) {
    const [text, setText] = createSignal("");
    const bitCount = () => (props.node ? NODE_TYPES[props.node.typeId].size * 8 : 0);

    // Seed the textarea from the node each time the window opens for a node.
    let seededFor: string | undefined;
    const seeded = () => {
        const n = props.node;
        if (n && seededFor !== n.id) {
            seededFor = n.id;
            setText((n.bitNames ?? []).join("\n"));
        }
        return text();
    };

    const save = () => {
        const names = seeded()
            .split("\n")
            .map((l) => l.trim())
            .slice(0, bitCount());
        // Trim trailing blanks so an all-blank edit clears the names entirely.
        while (names.length > 0 && names[names.length - 1] === "") names.pop();
        props.onSave(names);
        props.onClose();
    };

    return (
        <Window
            id="bit-names-window"
            title={`Bit names — ${props.node?.name ?? props.node?.typeId ?? ""}`}
            isOpen={props.node !== undefined}
            onClose={props.onClose}
            initialPos={{ x: 260, y: 140 }}
            initialSize={{ width: 320, height: 380 }}
            minWidth={240}
            minHeight={220}
            actions={
                <button type="button" class="win-btn" style={{ font: "inherit", "font-size": "12px", cursor: "pointer", padding: "2px 8px" }} onClick={save}>
                    save
                </button>
            }
        >
            <div class="panel-body bitnames-body">
                <Show when={props.node}>
                    <p class="bitnames-hint">
                        One name per line, first line is bit 0 (of {bitCount()}). Blank lines leave a bit unnamed.
                    </p>
                    <textarea
                        class="bitnames-text"
                        rows={16}
                        spellcheck={false}
                        value={seeded()}
                        onInput={(e) => setText(e.currentTarget.value)}
                    />
                </Show>
            </div>
        </Window>
    );
}
