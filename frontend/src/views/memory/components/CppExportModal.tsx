import { Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import type { MemoryClass } from "../state/MemoryContext";
import { exportClassToCpp } from "../export/cppExport";

// Modal displaying generated C++ header code for a MemoryClass definition.
// Allows easy copy-paste into Visual Studio / IDEs.

export function CppExportModal(props: {
    cls: MemoryClass | undefined;
    onClose: () => void;
}) {
    const [copied, setCopied] = createSignal(false);

    const code = () => (props.cls ? exportClassToCpp(props.cls) : "");

    const copyCode = () => {
        navigator.clipboard.writeText(code());
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <Show when={props.cls}>
            <Portal>
                <div class="scan-backdrop" onClick={props.onClose} />
                <div
                    class="panel cpp-modal-pop"
                    style={{
                        position: "fixed",
                        top: "50%",
                        left: "50%",
                        transform: "translate(-50%, -50%)",
                        "z-index": "40",
                        width: "600px",
                        "max-width": "90vw",
                        "max-height": "80vh",
                        "box-shadow": "0 16px 48px rgba(0, 0, 0, 0.5)",
                    }}
                >
                    <header class="panel-head">
                        <h2>C++ Header Export — {props.cls?.name}</h2>
                        <button onClick={copyCode}>
                            {copied() ? "copied!" : "copy code"}
                        </button>
                        <button onClick={props.onClose}>✕</button>
                    </header>
                    <div class="panel-body" style={{ padding: "12px", overflow: "auto" }}>
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
                </div>
            </Portal>
        </Show>
    );
}
