import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useStatic } from "../static/state/StaticContext";
import { Panel } from "../../ui/Panel";
import { StatusOverlay } from "../../ui/StatusOverlay";
import type { Instruction } from "../../protocol/types";
import { immediatesOf } from "../static/state/analysisXref";

// Search decoded instruction operands for an immediate value or a raw byte pattern, across
// either the selected function or the whole module (once its index is built). Immediate
// mode normalises the query and every operand literal to canonical hex so 0x10 and 16 match
// the same instructions; byte mode substring-matches the instruction's encoded bytes.

type Scope = "function" | "module";
type Mode = "value" | "bytes";

interface Hit {
    address: string;
    text: string;
}

function normalizeValue(query: string): string | null {
    const q = query.trim();
    if (!q) return null;
    try {
        const v = /^0x/i.test(q) ? BigInt(q) : BigInt(q);
        return `0x${v.toString(16)}`;
    } catch {
        return null;
    }
}

function matchValue(instrs: Instruction[], normalized: string, out: Hit[], cap: number) {
    for (const ins of instrs) {
        if (out.length >= cap) return;
        if (immediatesOf(ins.text).includes(normalized)) out.push({ address: ins.address, text: ins.text });
    }
}

function matchBytes(instrs: Instruction[], needle: string, out: Hit[], cap: number) {
    for (const ins of instrs) {
        if (out.length >= cap) return;
        if (ins.bytes.toLowerCase().includes(needle)) out.push({ address: ins.address, text: ins.text });
    }
}

const MAX_HITS = 500;

export function ImmediateSearchPanel() {
    const { selection, disasm, analysis, openAddress } = useStatic();

    const [mode, setMode] = createSignal<Mode>("value");
    const [scope, setScope] = createSignal<Scope>("function");
    const [query, setQuery] = createSignal("");

    const fn = () => selection.selectedFunction();

    createEffect(() => {
        const f = fn();
        if (f) disasm.ensure(f.address, f.size);
    });

    const moduleIndexed = () => analysis.status() === "ready" && analysis.builtModule() === fn()?.module;

    const hits = createMemo<Hit[]>(() => {
        const q = query().trim();
        if (!q) return [];
        const out: Hit[] = [];

        const scan = (instrs: Instruction[]) => {
            if (mode() === "value") {
                const norm = normalizeValue(q);
                if (norm) matchValue(instrs, norm, out, MAX_HITS);
            } else {
                const needle = q.replace(/[\s?]/g, "").toLowerCase();
                if (needle) matchBytes(instrs, needle, out, MAX_HITS);
            }
        };

        if (scope() === "function") {
            const f = fn();
            const e = f ? disasm.get(f.address) : undefined;
            if (e?.status === "ready") scan(e.data.results);
        } else if (moduleIndexed()) {
            for (const [, instrs] of analysis.disasmEntries()) {
                scan(instrs);
                if (out.length >= MAX_HITS) break;
            }
        }
        return out;
    });

    const valid = () => (mode() === "value" ? normalizeValue(query()) !== null : query().trim().length > 0);

    return (
        <Panel
            class="ana-panel"
            title="operand search"
            meta={
                <Show when={query().trim() && valid()} fallback="immediates & bytes">
                    {hits().length}{hits().length >= MAX_HITS ? "+" : ""} hits
                </Show>
            }
        >
            <div class="ana-search-controls">
                <div class="ana-seg">
                    <button classList={{ active: mode() === "value" }} onClick={() => setMode("value")}>
                        value
                    </button>
                    <button classList={{ active: mode() === "bytes" }} onClick={() => setMode("bytes")}>
                        bytes
                    </button>
                </div>
                <div class="ana-seg">
                    <button classList={{ active: scope() === "function" }} onClick={() => setScope("function")}>
                        function
                    </button>
                    <button
                        classList={{ active: scope() === "module" }}
                        onClick={() => setScope("module")}
                        title="requires the module index"
                    >
                        module
                    </button>
                </div>
                <input
                    class="ana-search-input"
                    type="text"
                    placeholder={mode() === "value" ? "e.g. 0x1000 or 4096" : "e.g. 48 8b or 488b"}
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                />
            </div>

            <div class="panel-body ana-search-results">
                <Show
                    when={scope() !== "module" || moduleIndexed()}
                    fallback={<StatusOverlay message="build the module index (call graph panel) to search module-wide" />}
                >
                    <Show
                        when={query().trim() && valid()}
                        fallback={<StatusOverlay message={fn() ? "enter a value or byte pattern" : "select a function"} />}
                    >
                        <Show when={hits().length} fallback={<StatusOverlay message="no matching operands" />}>
                            <For each={hits()}>
                                {(hit) => (
                                    <button class="ana-hit" onClick={() => openAddress(hit.address)} title={hit.address}>
                                        <span class="addr">{hit.address}</span>
                                        <span class="ana-ins-text">{hit.text}</span>
                                    </button>
                                )}
                            </For>
                        </Show>
                    </Show>
                </Show>
            </div>
        </Panel>
    );
}
