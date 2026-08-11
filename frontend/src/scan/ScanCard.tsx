import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../app/AppContext";
import { useStatic } from "../views/static/state/StaticContext";
import { useMemory } from "../views/memory/state/MemoryContext";
import { resolveRelative, sigScanIda } from "../protocol/requests";
import { StatusOverlay } from "../ui/StatusOverlay";
import { errorText } from "../state/errors";
import { ModulePicker } from "./ModulePicker";
import {
    resolveFunctionHits,
    filterFunctionHits,
    type FunctionHitFilterMode,
    type FunctionSigHit,
} from "./functionSigSearch";

// The pop-down signature scan card. Forwards an IDA pattern string to sig_scan_ida
// (the agent parses it), with an optional module scope and a find-all toggle (default
// off: first hit only).

export type ScanKind = "sig";

type Result =
    | { status: "idle" }
    | { status: "pending" }
    | { status: "empty" }
    | { status: "error"; error: string }
    | { status: "done"; hits: string[] };

export function ScanCard(props: { kind: ScanKind; onClose: () => void }) {
    const { client, attached, modules, annotations, history, setActiveView } = useApp();
    const staticState = useStatic();
    const memory = useMemory();

    const [pattern, setPattern] = createSignal(""); // IDA sig / string text
    const [scope, setScope] = createSignal(""); // a scan must target a module; "" = none picked yet
    const [findAll, setFindAll] = createSignal(false);
    const [filterMode, setFilterMode] = createSignal<FunctionHitFilterMode>("all");
    const [result, setResult] = createSignal<Result>({ status: "idle" });

    // RIP-relative follow parameters (sig scans): disp32 offset within the matched instruction
    // and the instruction's total length. Defaults match `mov rax, [rip+disp]` / `lea`.
    const [relOffset, setRelOffset] = createSignal(3);
    const [instLen, setInstLen] = createSignal(7);
    const [followError, setFollowError] = createSignal<string | null>(null);

    const scanning = () => result().status === "pending";
    const hasInput = () => pattern().trim().length > 0;
    const canScan = () => attached() && scope() !== "" && hasInput() && !scanning();

    function exec(): Promise<string[]> {
        return sigScanIda(client, { pattern: pattern().trim(), module: scope(), find_all: findAll() }).then(
            (r) => r.results,
        );
    }

    const scan = async () => {
        if (!canScan()) return;
        setFollowError(null);
        setResult({ status: "pending" });
        try {
            const hits = await exec();
            history.addScan({
                kind: "sig",
                pattern: pattern().trim(),
                scope: scope(),
                findAll: findAll(),
                relOffset: relOffset(),
                instLen: instLen(),
                hitCount: hits.length,
            });

            if (hits.length > 0) {
                if (scope()) {
                    staticState.functions.ensure(scope());
                }
                setResult({ status: "done", hits });
            } else {
                setResult({ status: "empty" });
            }
        } catch (e) {
            setResult({ status: "error", error: errorText(e) });
        }
    };

    // Resolved function hits for the current scan result
    const resolvedHits = createMemo<FunctionSigHit[]>(() => {
        const r = result();
        if (r.status !== "done" || !scope()) return [];

        const m = scope();
        const base = modules.baseOf(m);
        const cached = staticState.functions.get(m);
        const fns = cached?.status === "ready" ? cached.data : [];

        if (!base) return r.hits.map((addr) => ({
            hitAddress: addr,
            function: null,
            functionRva: null,
            functionName: null,
            offset: null,
            isPrologue: false,
        }));

        return resolveFunctionHits(r.hits, m, base, fns, annotations);
    });

    const filteredHits = createMemo(() => {
        return filterFunctionHits(resolvedHits(), filterMode());
    });

    const displayHits = createMemo(() => filteredHits().slice(0, 64));

    const mappedCount = () => resolvedHits().filter((h) => h.function !== null).length;
    const prologueCount = () => resolvedHits().filter((h) => h.isPrologue).length;

    // View function in Static View disassembly
    const viewFunction = (hitAddress: string) => {
        setActiveView("static");
        staticState.openAddress(hitAddress);
        props.onClose();
    };

    // A hit address spawns a memory class pointed at it
    const createClass = (address: string) => {
        memory.addClassAt(address);
        setActiveView("memory");
        props.onClose();
    };

    // Follow the RIP-relative reference at the hit and spawn a class there.
    const followToClass = async (address: string) => {
        setFollowError(null);
        try {
            const r = await resolveRelative(client, { address, offset: relOffset(), inst_size: instLen() });
            if (!r.success) {
                setFollowError(`could not resolve reference at ${address}`);
                return;
            }
            createClass(r.address);
        } catch (e) {
            setFollowError(errorText(e));
        }
    };

    const wildcardDisp = () => {
        const raw = pattern().trim();
        if (!raw) return;
        const tokens = raw.split(/\s+/);
        const offset = relOffset();
        const iLen = instLen();
        const dispLen = 4;
        // Only wildcard within the bounds of the first instruction (instLen tokens).
        // If the pattern is shorter than instLen, use the full pattern length as boundary.
        const boundary = Math.min(iLen, tokens.length);
        if (offset >= 0 && offset + dispLen <= boundary) {
            for (let i = offset; i < offset + dispLen; i++) {
                tokens[i] = "??";
            }
            setPattern(tokens.join(" "));
        }
    };

    const clear = () => {
        setPattern("");
        setResult({ status: "idle" });
        setFollowError(null);
    };

    const overlayMessage = (): string | false => {
        const r = result();
        switch (r.status) {
            case "idle":
                return "results appear here after a scan";
            case "pending":
                return "scanning…";
            case "empty":
                return "no matches";
            case "error":
                return r.error;
            case "done":
                return false;
        }
    };

    return (
        <section class="scan-card panel" style={{ flex: "1 1 auto", height: "100%", border: "none", "border-radius": "0", "box-shadow": "none" }}>
            <div class="scan-controls">
                <div style={{ display: "flex", gap: "6px" }}>
                    <input
                        class="scan-input"
                        type="text"
                        placeholder="48 8B ?? ?? E8"
                        value={pattern()}
                        onInput={(e) => setPattern(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === "Enter" && scan()}
                    />
                    <button
                        type="button"
                        onClick={clear}
                        title="Clear pattern and results"
                        style={{ font: "inherit", "font-size": "12px", cursor: "pointer", padding: "4px 10px" }}
                    >
                        clear
                    </button>
                    <button
                        type="button"
                        onClick={scan}
                        disabled={!canScan()}
                        style={{
                            font: "inherit",
                            "font-size": "12px",
                            cursor: "pointer",
                            padding: "4px 12px",
                            color: "var(--accent)",
                            background: "var(--accent-bg)",
                            border: "1px solid var(--accent-border)",
                            "border-radius": "5px",
                            "white-space": "nowrap",
                        }}
                    >
                        {scanning() ? "scanning…" : "scan"}
                    </button>
                </div>

                <div class="scan-options">
                    <label class="scan-field">
                        <ModulePicker value={scope()} onChange={setScope} />
                    </label>

                    <label class="scan-field check">
                        <input
                            type="checkbox"
                            checked={findAll()}
                            onChange={(e) => setFindAll(e.currentTarget.checked)}
                        />
                        find all matches
                    </label>

                    <label class="scan-field" title="byte offset of the disp32 inside the matched instruction">
                        byte offset
                        <input
                            class="scan-num"
                            type="number"
                            min="0"
                            value={relOffset()}
                            onInput={(e) => setRelOffset(Math.max(0, e.currentTarget.valueAsNumber || 0))}
                        />
                    </label>
                    <label class="scan-field" title="total length of the matched instruction in bytes">
                        instruction length
                        <input
                            class="scan-num"
                            type="number"
                            min="0"
                            value={instLen()}
                            onInput={(e) => setInstLen(Math.max(0, e.currentTarget.valueAsNumber || 0))}
                        />
                    </label>
                    <button
                        type="button"
                        style={{ font: "inherit", "font-size": "12px", cursor: "pointer", padding: "2px 8px" }}
                        title="replace 4 bytes at offset with ??"
                        onClick={wildcardDisp}
                    >
                        wildcard disp32
                    </button>
                </div>

                <Show when={result().status === "done" && resolvedHits().length > 0}>
                    <div class="scan-filter-modes">
                        <span class="scan-filter-label">function filter:</span>
                        <button
                            classList={{ active: filterMode() === "all" }}
                            onClick={() => setFilterMode("all")}
                        >
                            all ({resolvedHits().length})
                        </button>
                        <button
                            classList={{ active: filterMode() === "mapped" }}
                            onClick={() => setFilterMode("mapped")}
                        >
                            mapped functions ({mappedCount()})
                        </button>
                        <button
                            classList={{ active: filterMode() === "prologue" }}
                            onClick={() => setFilterMode("prologue")}
                        >
                            prologues (+0x0) ({prologueCount()})
                        </button>
                    </div>
                </Show>

                <Show when={!attached()}>
                    <p class="scan-warn">no process attached.</p>
                </Show>
                <Show when={attached() && !scope()}>
                    <p class="scan-warn">select a module to scan.</p>
                </Show>
                <Show when={followError()}>{(msg) => <p class="scan-warn">{msg()}</p>}</Show>
            </div>

            <div class="panel-body">
                <div class="list scan-results">
                    <For each={displayHits()}>
                        {(hit) => (
                            <div class="row scan-hit">
                                <span class="addr">{hit.hitAddress}</span>
                                <Show
                                    when={hit.function}
                                    fallback={<span class="fn-badge unmapped">unmapped</span>}
                                >
                                    <span
                                        class="fn-badge"
                                        classList={{ prologue: hit.isPrologue }}
                                        title={`Function ${hit.functionName} @ ${hit.function?.address}`}
                                    >
                                        {hit.isPrologue ? "★ PROLOGUE " : `+0x${hit.offset?.toString(16)} `}
                                        {hit.functionName}
                                    </span>
                                </Show>
                                <div class="scan-hit-actions">
                                    <button
                                        title="view function disassembly in modules view"
                                        onClick={() => viewFunction(hit.hitAddress)}
                                    >
                                        view function
                                    </button>
                                    <button
                                        title="create memory class at this hit address"
                                        onClick={() => createClass(hit.hitAddress)}
                                    >
                                        create class
                                    </button>
                                    <button
                                        title="follow RIP-relative reference and create class"
                                        onClick={() => followToClass(hit.hitAddress)}
                                    >
                                        follow ref
                                    </button>
                                </div>
                            </div>
                        )}
                    </For>
                </div>
                <StatusOverlay message={overlayMessage()} error={result().status === "error"} />
            </div>
        </section>
    );
}
