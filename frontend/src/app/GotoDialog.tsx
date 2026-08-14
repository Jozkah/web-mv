import { Show, createMemo, createSignal, onMount } from "solid-js";
import { useApp } from "./AppContext";
import { resolveGotoInput } from "./useNavigation";
import type { NavKind } from "../state/navStore";

// The Goto (Ctrl+G) modal. Resolves free-form input - a `module+offset` or an address expression -
// to an absolute address, previews the resolved label live, then jumps to it in the disassembler
// or the memory (ReClass) view. The actual jump is delegated up to the caller (which owns the nav
// coordinator) so this component stays a pure input surface.

interface GotoDialogProps {
    onClose: () => void;
    onGo: (kind: NavKind, address: string, label: string) => void;
}

export function GotoDialog(props: GotoDialogProps) {
    const { modules } = useApp();
    const [text, setText] = createSignal("");
    let inputRef: HTMLInputElement | undefined;

    onMount(() => inputRef?.focus());

    const resolved = createMemo(() => resolveGotoInput(text(), modules.list()));

    const go = (kind: NavKind) => {
        const r = resolved();
        if (!r) return;
        props.onGo(kind, r.address, r.label);
        props.onClose();
    };

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
        } else if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey || e.ctrlKey || e.metaKey ? "memory" : "static");
        }
    };

    return (
        <div class="goto-overlay" onPointerDown={props.onClose}>
            <div class="goto-dialog" onPointerDown={(e) => e.stopPropagation()}>
                <h3>Go to address</h3>
                <input
                    ref={inputRef}
                    type="text"
                    spellcheck={false}
                    autocomplete="off"
                    placeholder="0x7ff6… + 0x28   ·   game.dll+0x1a3f"
                    value={text()}
                    onInput={(e) => setText(e.currentTarget.value)}
                    onKeyDown={onKeyDown}
                />
                <Show
                    when={text().trim().length > 0}
                    fallback={<div class="goto-preview" />}
                >
                    <Show
                        when={resolved()}
                        fallback={<div class="goto-preview bad">Unresolved address or unknown module</div>}
                    >
                        {(r) => (
                            <div class="goto-preview ok">
                                → {r().address}
                                <Show when={r().label !== r().address}> · {r().label}</Show>
                            </div>
                        )}
                    </Show>
                </Show>
                <div class="goto-actions">
                    <span class="goto-hint">Enter → Disasm · Shift+Enter → ReClass · Esc to cancel</span>
                    <div class="goto-buttons">
                        <button disabled={!resolved()} onClick={() => go("memory")}>
                            ReClass
                        </button>
                        <button class="primary" disabled={!resolved()} onClick={() => go("static")}>
                            Disasm
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
