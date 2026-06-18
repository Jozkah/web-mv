import { createEffect, createSignal } from "solid-js";
import { parseAddressExpr, toHex } from "../../../state/address";
import { useMemory } from "../state/MemoryContext";

// The address bar for the active class: an address-expression input that resolves to a
// canonical address live. Terms are hex by default (a bare value or
// "0x..."); plain decimal digits read as decimal, and terms can be added/subtracted, e.g.
// "0x4a486a8d000 + 0x28". Editing updates the active class's address live as you type (every
// valid keystroke), so the region reads immediately - no button or Enter needed. Blur tidies
// the field to the resolved canonical address.

function normalize(text: string): string | undefined {
    if (!text.trim()) return "";
    const value = parseAddressExpr(text);
    return value === undefined ? undefined : toHex(value);
}

export function AddressBar() {
    const memory = useMemory();
    const [text, setText] = createSignal(memory.activeClass()?.address ?? "");

    // Resync the field only when the active class itself changes (switching tabs/classes), not
    // when our own live edits change its address - otherwise the field would fight the typist.
    let syncedId = memory.activeClass()?.id;
    createEffect(() => {
        const cls = memory.activeClass();
        if (cls?.id !== syncedId) {
            syncedId = cls?.id;
            setText(cls?.address ?? "");
        }
    });

    const onInput = (value: string) => {
        setText(value);
        const normalized = normalize(value);
        if (normalized !== undefined) memory.setAddress(normalized);
    };

    return (
        <div class="address-bar">
            <div class="address-label">
                Address {memory.activeClass()?.name ? `(${memory.activeClass()!.name})` : ""}
            </div>
            <div class="address-input-row">
                <input
                    class="address-input"
                    type="text"
                    spellcheck={false}
                    placeholder="0x0000000000000000"
                    value={text()}
                    onInput={(e) => onInput(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    onBlur={() => {
                        const n = normalize(text());
                        if (n) setText(n);
                    }}
                />
            </div>
        </div>
    );
}
