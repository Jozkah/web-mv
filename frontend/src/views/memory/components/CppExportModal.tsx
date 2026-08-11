import { createSignal } from "solid-js";
import type { MemoryClass } from "../state/MemoryContext";
import { exportClassToCpp } from "../export/cppExport";
import { Window } from "../../../ui/Window";

// Floating window displaying generated C++ header code for a MemoryClass definition.
// Allows easy copy-paste into Visual Studio / IDEs while staying open alongside the class view.

export function CppExportModal(props: {
    cls: MemoryClass | undefined;
    onClose: () => void;
}) {
    const [copied, setCopied] = createSignal(false);
    const [pinned, setPinned] = createSignal(false);

    const code = () => (props.cls ? exportClassToCpp(props.cls) : "");

    const copyCode = () => {
        navigator.clipboard.writeText(code());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <Window
            id="cpp-export-window"
            title={`C++ Header Export — ${props.cls?.name ?? ""}`}
            isOpen={props.cls !== undefined}
            onClose={props.onClose}
            isPinned={pinned()}
            onTogglePin={() => setPinned((p) => !p)}
            initialPos={{ x: 200, y: 100 }}
            initialSize={{ width: 620, height: 460 }}
            minWidth={400}
            minHeight={250}
            actions={
                <button
                    type="button"
                    class="win-btn"
                    onClick={copyCode}
                    style={{ font: "inherit", "font-size": "12px", cursor: "pointer", padding: "2px 8px" }}
                >
                    {copied() ? "copied!" : "copy code"}
                </button>
            }
        >
            <div class="panel-body" style={{ padding: "12px", overflow: "auto", height: "100%" }}>
                <pre
                    style={{
                        margin: 0,
                        "font-family": "var(--mono)",
                        "font-size": "13px",
                        "line-height": "1.4",
                        color: "var(--text-h)",
                        "white-space": "pre-wrap",
                        "word-break": "break-all",
                    }}
                >
                    <code>{code()}</code>
                </pre>
            </div>
        </Window>
    );
}
