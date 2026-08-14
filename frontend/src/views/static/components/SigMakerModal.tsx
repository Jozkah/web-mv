import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { useApp } from "../../../app/AppContext";
import type { Instruction } from "../../../protocol/types";
import { disassemble, read, sigScanIda } from "../../../protocol/requests";
import type { SigMakerTarget } from "../sigmaker/SigMakerContext";
import {
    type AnalyzedInstruction,
    type SigFormat,
    type SigOptions,
    DEFAULT_SIG_OPTIONS,
    analyzeInstruction,
    analyzeRawBytes,
    buildSigResult,
    findShortestUniqueSig,
    resolveModule,
} from "../sigmaker/sigmakerEngine";
import "./sigmaker.css";

export interface SigMakerModalProps {
    target: SigMakerTarget;
    onClose: () => void;
}

// How many bytes to read/disassemble by default when a target does not specify a size.
const DEFAULT_LENGTH = 64;

export function SigMakerModal(props: SigMakerModalProps) {
    const { client, attached, modules } = useApp();

    // --- Source selection: which bytes we are signaturing ---------------------------------------
    const [address, setAddress] = createSignal(props.target.address ?? "");
    const [byteLen, setByteLen] = createSignal(props.target.size ?? DEFAULT_LENGTH);
    const [source, setSource] = createSignal<"code" | "raw">(props.target.source ?? "code");
    const [instructions, setInstructions] = createSignal<Instruction[]>(props.target.instructions ?? []);
    const [rawHex, setRawHex] = createSignal("");
    const [loading, setLoading] = createSignal(false);
    const [loadError, setLoadError] = createSignal<string | null>(null);

    const [options, setOptions] = createSignal<SigOptions>({ ...DEFAULT_SIG_OPTIONS });
    const [mode, setMode] = createSignal<"auto" | "prologue" | "range">("auto");
    const [startIndex, setStartIndex] = createSignal(0);
    const [rangeLength, setRangeLength] = createSignal(6);
    const [activeFormat, setActiveFormat] = createSignal<SigFormat>("ida");
    const [copied, setCopied] = createSignal(false);

    // Manual byte overrides: key = `${instIndex}_${byteIndex}`, value = boolean (isWildcard)
    const [manualOverrides, setManualOverrides] = createSignal<Map<string, boolean>>(new Map());

    // Status state
    const [scanning, setScanning] = createSignal(false);
    const [scanHits, setScanHits] = createSignal<number | null>(null);
    const [statusError, setStatusError] = createSignal<string | null>(null);

    // Module scope: explicit from the target, else resolved from the address by containment.
    const moduleName = () => props.target.moduleName || resolveModule(address(), modules.list()) || "";

    const toggleOption = (key: keyof SigOptions) => {
        setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
        setManualOverrides(new Map());
    };

    // Fetch the bytes for the current address/length/source. Code mode disassembles; raw mode
    // reads bytes verbatim. Resets manual overrides and scan status since the byte set changed.
    const load = async () => {
        const addr = address().trim();
        if (!addr) {
            setLoadError("Enter an address");
            return;
        }
        if (!attached()) {
            setLoadError("Agent not attached");
            return;
        }
        setLoading(true);
        setLoadError(null);
        setManualOverrides(new Map());
        setScanHits(null);
        try {
            if (source() === "raw") {
                const res = await read(client, { address: addr, size: byteLen() });
                setRawHex(res.data ?? "");
                setInstructions([]);
            } else {
                const res = await disassemble(client, { address: addr, size: byteLen() });
                setInstructions(res.results ?? []);
                setRawHex("");
            }
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    };

    const switchSource = (next: "code" | "raw") => {
        if (source() === next) return;
        setSource(next);
        if (address().trim()) void load();
    };

    // On open: if the launcher already handed us disassembled instructions, use them; otherwise
    // fetch from the seeded address. A blank target just waits for the user to type an address.
    onMount(() => {
        if (props.target.instructions?.length) return;
        if (address().trim()) void load();
    });

    // Instruction subset according to mode (code mode only).
    const selectedInstructions = createMemo(() => {
        const insts = instructions();
        if (!insts || insts.length === 0) return [];
        const start = Math.max(0, Math.min(startIndex(), insts.length - 1));

        if (mode() === "prologue") {
            return insts.slice(0, Math.min(rangeLength(), insts.length));
        }
        return insts.slice(start, Math.min(start + rangeLength(), insts.length));
    });

    // Base analyzed instructions (before manual overrides), branching on source.
    const baseAnalyzed = createMemo<AnalyzedInstruction[]>(() => {
        if (source() === "raw") {
            const hex = rawHex();
            return hex ? [analyzeRawBytes(hex, address())] : [];
        }
        const opts = options();
        return selectedInstructions().map((inst) => analyzeInstruction(inst, opts));
    });

    // Apply manual per-byte wildcard overrides on top of the base analysis.
    const analyzedInstructions = createMemo<AnalyzedInstruction[]>(() => {
        const overrides = manualOverrides();
        return baseAnalyzed().map((inst, instIdx) => {
            const bytes = inst.bytes.map((b, byteIdx) => {
                const key = `${instIdx}_${byteIdx}`;
                return overrides.has(key) ? { ...b, isWildcard: overrides.get(key)! } : b;
            });
            return { ...inst, bytes };
        });
    });

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
        if (!sig || !attached()) return;

        setScanning(true);
        setStatusError(null);
        try {
            const res = await sigScanIda(client, {
                pattern: sig,
                module: moduleName() || undefined,
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

    // Auto find shortest unique signature (code mode only).
    const runAutoFind = async () => {
        if (source() !== "code" || !instructions().length || !attached()) return;

        setScanning(true);
        setStatusError(null);
        setManualOverrides(new Map());

        try {
            const result = await findShortestUniqueSig(
                client,
                moduleName(),
                instructions(),
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

    // Run auto-find once instructions are available in 'auto' mode (code only).
    createEffect(() => {
        if (source() === "code" && mode() === "auto" && attached() && instructions().length > 0) {
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
                            {moduleName() || "no module"}{" "}
                            {props.target.functionName ? `· ${props.target.functionName}` : ""}{" "}
                            {address() ? `(${address()})` : ""}
                        </span>
                    </div>
                    <button class="sigmaker-close-btn" onClick={props.onClose}>
                        ✕
                    </button>
                </header>

                <div class="sigmaker-body">
                    {/* Source / target panel: address, length, code-vs-raw, load */}
                    <div class="sigmaker-source">
                        <div class="sigmaker-mode-group">
                            <span class="sigmaker-label">Source:</span>
                            <button
                                classList={{ active: source() === "code" }}
                                onClick={() => switchSource("code")}
                                title="Disassemble at the address and signature the instructions"
                            >
                                🧩 Code
                            </button>
                            <button
                                classList={{ active: source() === "raw" }}
                                onClick={() => switchSource("raw")}
                                title="Read raw bytes at the address (data / unresolved code)"
                            >
                                🧱 Raw bytes
                            </button>
                        </div>
                        <label class="sigmaker-range-label">
                            Address:
                            <input
                                type="text"
                                class="sigmaker-addr-input"
                                spellcheck={false}
                                placeholder="0x…"
                                value={address()}
                                onInput={(e) => setAddress(e.currentTarget.value)}
                                onKeyDown={(e) => e.key === "Enter" && void load()}
                            />
                        </label>
                        <label class="sigmaker-range-label">
                            Length:
                            <input
                                type="number"
                                min="1"
                                max="4096"
                                value={byteLen()}
                                onInput={(e) => setByteLen(Math.max(1, e.currentTarget.valueAsNumber || 1))}
                            />
                        </label>
                        <button
                            class="sigmaker-btn primary"
                            onClick={() => void load()}
                            disabled={loading() || !attached() || !address().trim()}
                        >
                            {loading() ? "Loading…" : "⟳ Load"}
                        </button>
                    </div>

                    {/* Control & Mode Panel */}
                    <div class="sigmaker-controls">
                        <Show when={source() === "code"}>
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
                        </Show>

                        <div class="sigmaker-actions-group">
                            <Show when={source() === "code" && (mode() === "range" || mode() === "prologue")}>
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
                            <Show when={source() === "code" && mode() === "range"}>
                                <label class="sigmaker-range-label">
                                    Start inst:
                                    <input
                                        type="number"
                                        min="0"
                                        max={Math.max(0, instructions().length - 1)}
                                        value={startIndex()}
                                        onInput={(e) => setStartIndex(Math.max(0, Math.min(instructions().length - 1, e.currentTarget.valueAsNumber || 0)))}
                                    />
                                </label>
                            </Show>

                            <Show when={source() === "code"}>
                                <button
                                    class="sigmaker-btn primary"
                                    onClick={runAutoFind}
                                    disabled={scanning() || !attached()}
                                >
                                    {scanning() ? "Scanning…" : "⚡ Auto Find Unique"}
                                </button>
                            </Show>

                            <button
                                class="sigmaker-btn"
                                onClick={testUniqueness}
                                disabled={scanning() || !attached()}
                            >
                                🎯 Test Uniqueness
                            </button>
                        </div>
                    </div>

                    {/* Load error indicator */}
                    <Show when={loadError()}>
                        {(err) => <div class="sigmaker-status-bar"><span class="status-pill err">✖ {err()}</span></div>}
                    </Show>

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
                                        ⚠ {scanHits()} matches found in {moduleName() || "target"} (Not Unique)
                                    </span>
                                }
                            >
                                <span class="status-pill success">
                                    ★ UNIQUE SIGNATURE (1 hit in {moduleName() || "target"})
                                </span>
                            </Show>
                        </Show>

                        <div class="sigmaker-meta-info">
                            <span>{sigResult().instructionCount} {source() === "raw" ? "block" : "instructions"}</span>
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
