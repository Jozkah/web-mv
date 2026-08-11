import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useApp } from "../../../app/AppContext";
import type { Instruction } from "../../../protocol/types";
import { sigScanIda } from "../../../protocol/requests";
import {
    type AnalyzedInstruction,
    type SigFormat,
    type SigOptions,
    DEFAULT_SIG_OPTIONS,
    analyzeInstruction,
    buildSigResult,
    findShortestUniqueSig,
} from "../sigmaker/sigmakerEngine";
import "./sigmaker.css";

export interface SigMakerModalProps {
    moduleName: string;
    functionName?: string | null;
    functionAddress?: string;
    instructions: Instruction[];
    initialStartIndex?: number;
    onClose: () => void;
}

export function SigMakerModal(props: SigMakerModalProps) {
    const { client, attached } = useApp();

    const [options, setOptions] = createSignal<SigOptions>({ ...DEFAULT_SIG_OPTIONS });
    const [mode, setMode] = createSignal<"auto" | "prologue" | "range">("auto");
    const [startIndex] = createSignal(props.initialStartIndex ?? 0);
    const [rangeLength, setRangeLength] = createSignal(6);
    const [activeFormat, setActiveFormat] = createSignal<SigFormat>("ida");
    const [copied, setCopied] = createSignal(false);

    // Manual byte overrides: key = `${instIndex}_${byteIndex}`, value = boolean (isWildcard)
    const [manualOverrides, setManualOverrides] = createSignal<Map<string, boolean>>(new Map());

    // Status state
    const [scanning, setScanning] = createSignal(false);
    const [scanHits, setScanHits] = createSignal<number | null>(null);
    const [statusError, setStatusError] = createSignal<string | null>(null);

    const toggleOption = (key: keyof SigOptions) => {
        setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
        setManualOverrides(new Map());
    };

    // Instruction subset according to mode
    const selectedInstructions = createMemo(() => {
        const insts = props.instructions;
        if (!insts || insts.length === 0) return [];
        const start = Math.max(0, Math.min(startIndex(), insts.length - 1));

        if (mode() === "prologue") {
            return insts.slice(0, Math.min(rangeLength(), insts.length));
        }
        if (mode() === "range") {
            return insts.slice(start, Math.min(start + rangeLength(), insts.length));
        }
        // mode === "auto": defaults to starting range or up to rangeLength until auto scan updates it
        return insts.slice(start, Math.min(start + rangeLength(), insts.length));
    });

    // Base analyzed instructions
    const analyzedInstructions = createMemo<AnalyzedInstruction[]>(() => {
        const opts = options();
        const overrides = manualOverrides();
        const insts = selectedInstructions();

        return insts.map((inst, instIdx) => {
            const base = analyzeInstruction(inst, opts);
            const bytes = base.bytes.map((b, byteIdx) => {
                const key = `${instIdx}_${byteIdx}`;
                if (overrides.has(key)) {
                    return { ...b, isWildcard: overrides.get(key)! };
                }
                return b;
            });
            return { ...base, bytes };
        });
    });

    // Calculated signature formats
    const sigResult = createMemo(() => buildSigResult(analyzedInstructions()));

    // Toggle byte wildcard manually
    const toggleByteWildcard = (instIdx: number, byteIdx: number) => {
        const key = `${instIdx}_${byteIdx}`;
        const insts = analyzedInstructions();
        const current = insts[instIdx]?.bytes[byteIdx]?.isWildcard ?? false;

        const nextMap = new Map(manualOverrides());
        nextMap.set(key, !current);
        setManualOverrides(nextMap);
        setScanHits(null); // invalidate scan hits status on manual edit
    };

    // Live scan test for current signature
    const testUniqueness = async () => {
        const sig = sigResult().idaPattern;
        if (!sig || !props.moduleName || !attached()) return;

        setScanning(true);
        setStatusError(null);
        try {
            const res = await sigScanIda(client, {
                pattern: sig,
                module: props.moduleName,
                find_all: true,
            });
            setScanHits(res.results?.length ?? 0);
        } catch (err) {
            setStatusError(err instanceof Error ? err.message : String(err));
            setScanHits(null);
        } finally {
            setScanning(false);
        }
    };

    // Auto find shortest unique signature
    const runAutoFind = async () => {
        if (!props.moduleName || !props.instructions.length || !attached()) return;

        setScanning(true);
        setStatusError(null);
        setManualOverrides(new Map());

        try {
            const result = await findShortestUniqueSig(
                client,
                props.moduleName,
                props.instructions,
                startIndex(),
                options(),
                15,
            );

            if (result.searchDepth > 0) {
                setRangeLength(result.searchDepth);
                setScanHits(result.matchCount);
            }
            if (result.error) {
                setStatusError(result.error);
            }
        } catch (err) {
            setStatusError(err instanceof Error ? err.message : String(err));
        } finally {
            setScanning(false);
        }
    };

    // Run auto-find on mount if in 'auto' mode
    createEffect(() => {
        if (mode() === "auto" && attached() && props.instructions.length > 0) {
            runAutoFind();
        }
    });

    const copyFormat = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
    };

    const activeExportText = createMemo(() => {
        const r = sigResult();
        switch (activeFormat()) {
            case "ida":
                return r.idaPattern;
            case "cpp_str":
                return `// Pattern: ${r.cppString}\n// Mask:    ${r.cppMask}\nconst char* pattern = "${r.cppString}";\nconst char* mask = "${r.cppMask}";`;
            case "cpp_array":
                return `// C++ Byte Array\nconst uint8_t pattern[] = ${r.cppArray};\nconst char* mask = "${r.cppMask}";`;
            case "cpp_hexmask":
                return `// C++ 0x?? Format\nconst uint8_t pattern[] = ${r.cppHexMask};`;
            case "python":
                return `# Python pattern\npattern = ${r.pythonBytes}\nmask = "${r.cppMask}"`;
        }
    });

    return (
        <div class="sigmaker-backdrop" onClick={props.onClose}>
            <div class="sigmaker-modal" onClick={(e) => e.stopPropagation()}>
                <header class="sigmaker-header">
                    <div class="sigmaker-title-box">
                        <h3>⚡ IDA SigMaker</h3>
                        <span class="sigmaker-subtitle">
                            {props.moduleName} {props.functionName ? `· ${props.functionName}` : ""}{" "}
                            {props.functionAddress ? `(${props.functionAddress})` : ""}
                        </span>
                    </div>
                    <button class="sigmaker-close-btn" onClick={props.onClose}>
                        ✕
                    </button>
                </header>

                <div class="sigmaker-body">
                    {/* Control & Mode Panel */}
                    <div class="sigmaker-controls">
                        <div class="sigmaker-mode-group">
                            <span class="sigmaker-label">Mode:</span>
                            <button
                                classList={{ active: mode() === "auto" }}
                                onClick={() => {
                                    setMode("auto");
                                    runAutoFind();
                                }}
                                title="Auto-expand instructions until signature is 100% unique in module"
                            >
                                ⚡ Auto Unique Sig
                            </button>
                            <button
                                classList={{ active: mode() === "prologue" }}
                                onClick={() => setMode("prologue")}
                                title="Signature starting from function entry (+0x0)"
                            >
                                🎯 Function Prologue
                            </button>
                            <button
                                classList={{ active: mode() === "range" }}
                                onClick={() => setMode("range")}
                                title="Custom instruction range selection"
                            >
                                🔍 Range Selection
                            </button>
                        </div>

                        <div class="sigmaker-options-group">
                            <label class="sigmaker-check">
                                <input
                                    type="checkbox"
                                    checked={options().wildcardRip}
                                    onChange={() => toggleOption("wildcardRip")}
                                />
                                Wildcard RIP Disp (disp32)
                            </label>
                            <label class="sigmaker-check">
                                <input
                                    type="checkbox"
                                    checked={options().wildcardCalls}
                                    onChange={() => toggleOption("wildcardCalls")}
                                />
                                Wildcard Calls/Jmps (rel32)
                            </label>
                            <label class="sigmaker-check">
                                <input
                                    type="checkbox"
                                    checked={options().wildcardImmediates}
                                    onChange={() => toggleOption("wildcardImmediates")}
                                />
                                Wildcard Immediates
                            </label>
                        </div>

                        <div class="sigmaker-actions-group">
                            <Show when={mode() === "range" || mode() === "prologue"}>
                                <label class="sigmaker-range-label">
                                    Inst count:
                                    <input
                                        type="number"
                                        min="1"
                                        max="30"
                                        value={rangeLength()}
                                        onInput={(e) => setRangeLength(Math.max(1, e.currentTarget.valueAsNumber || 1))}
                                    />
                                </label>
                            </Show>

                            <button
                                class="sigmaker-btn primary"
                                onClick={runAutoFind}
                                disabled={scanning() || !attached()}
                            >
                                {scanning() ? "Scanning…" : "⚡ Auto Find Unique"}
                            </button>

                            <button
                                class="sigmaker-btn"
                                onClick={testUniqueness}
                                disabled={scanning() || !attached()}
                            >
                                🎯 Test Uniqueness
                            </button>
                        </div>
                    </div>

                    {/* Uniqueness Status Indicator */}
                    <div class="sigmaker-status-bar">
                        <Show
                            when={scanHits() !== null}
                            fallback={
                                <Show when={statusError()}>
                                    {(err) => <span class="status-pill err">✖ {err()}</span>}
                                </Show>
                            }
                        >
                            <Show
                                when={scanHits() === 1}
                                fallback={
                                    <span class="status-pill warn">
                                        ⚠ {scanHits()} matches found in {props.moduleName} (Not Unique)
                                    </span>
                                }
                            >
                                <span class="status-pill success">
                                    ★ UNIQUE SIGNATURE (1 hit in {props.moduleName})
                                </span>
                            </Show>
                        </Show>

                        <div class="sigmaker-meta-info">
                            <span>{sigResult().instructionCount} instructions</span>
                            <span>·</span>
                            <span>{sigResult().totalBytes} bytes ({sigResult().wildcardCount} wildcarded)</span>
                        </div>
                    </div>

                    {/* Instruction Breakdown & Byte Pill Visualizer */}
                    <div class="sigmaker-inst-list">
                        <For each={analyzedInstructions()}>
                            {(inst, instIdx) => (
                                <div class="sigmaker-inst-row">
                                    <span class="inst-addr">{inst.address}</span>
                                    <span class="inst-text">{inst.text}</span>
                                    <div class="byte-pills">
                                        <For each={inst.bytes}>
                                            {(b, byteIdx) => (
                                                <button
                                                    class="byte-pill"
                                                    classList={{ wildcard: b.isWildcard }}
                                                    title={
                                                        b.isWildcard
                                                            ? `Wildcarded (${b.reason || "custom"}). Click to keep byte.`
                                                            : `Byte ${b.hex}. Click to wildcard.`
                                                    }
                                                    onClick={() => toggleByteWildcard(instIdx(), byteIdx())}
                                                >
                                                    {b.isWildcard ? "??" : b.hex}
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </div>
                            )}
                        </For>
                    </div>

                    {/* Format Tabs & Output Exporter */}
                    <div class="sigmaker-exporter">
                        <div class="exporter-tabs">
                            <button
                                classList={{ active: activeFormat() === "ida" }}
                                onClick={() => setActiveFormat("ida")}
                            >
                                IDA Pattern
                            </button>
                            <button
                                classList={{ active: activeFormat() === "cpp_str" }}
                                onClick={() => setActiveFormat("cpp_str")}
                            >
                                C++ String & Mask
                            </button>
                            <button
                                classList={{ active: activeFormat() === "cpp_array" }}
                                onClick={() => setActiveFormat("cpp_array")}
                            >
                                C++ Byte Array
                            </button>
                            <button
                                classList={{ active: activeFormat() === "cpp_hexmask" }}
                                onClick={() => setActiveFormat("cpp_hexmask")}
                            >
                                C++ 0x?? Array
                            </button>
                            <button
                                classList={{ active: activeFormat() === "python" }}
                                onClick={() => setActiveFormat("python")}
                            >
                                Python
                            </button>

                            <button
                                class="copy-btn"
                                onClick={() => copyFormat(activeExportText() || "")}
                            >
                                {copied() ? "✓ Copied!" : "📋 Copy Pattern"}
                            </button>
                        </div>

                        <pre class="exporter-code">
                            <code>{activeExportText()}</code>
                        </pre>
                    </div>
                </div>
            </div>
        </div>
    );
}
