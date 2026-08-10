import { For, Show, createSignal } from "solid-js";
import { useApp } from "../app/AppContext";
import { useMemory } from "../views/memory/state/MemoryContext";
import { resolveRelative, sigScanIda } from "../protocol/requests";
import { StatusOverlay } from "../ui/StatusOverlay";
import { errorText } from "../state/errors";
import { ModulePicker } from "./ModulePicker";

// The pop-down signature scan card. Forwards an IDA pattern string to sig_scan_ida
// (the agent parses it), with an optional module scope and a find-all toggle (default
// off: first hit only).
//
// A sig-scan hit can either spawn a class at the hit itself ("create class") or follow a
// RIP-relative reference inside the matched bytes ("follow ref"): for a `mov rax, [rip+disp]`
// the displacement sits at offset 3 of a 7-byte instruction, so the agent resolves the target
// and we open the class there. The two byte fields default to that common case and are
// editable for other instruction shapes (e.g. `E8` call = offset 1, len 5).

export type ScanKind = "sig";

type Result =
    | { status: "idle" }
    | { status: "pending" }
    | { status: "empty" }
    | { status: "error"; error: string }
    | { status: "done"; hits: string[] };

export function ScanCard(props: { kind: ScanKind; onClose: () => void }) {
    const { client, attached, setActiveView } = useApp();
    const memory = useMemory();

    const [pattern, setPattern] = createSignal(""); // IDA sig / string text
    const [scope, setScope] = createSignal(""); // a scan must target a module; "" = none picked yet
    const [findAll, setFindAll] = createSignal(false);
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
        return sigScanIda(client, { pattern: pattern().trim(), module: scope(), find_all: findAll() }).then((r) => r.results);
    }

    const scan = async () => {
        if (!canScan()) return;
        setFollowError(null);
        setResult({ status: "pending" });
        try {
            const hits = await exec();
            setResult(hits.length > 0 ? { status: "done", hits } : { status: "empty" });
        } catch (e) {
            setResult({ status: "error", error: errorText(e) });
        }
    };

    // A hit address spawns a memory class pointed at it, or jumps the static view to the
    // function that contains it. Both switch the active page and dismiss the card.
    const createClass = (address: string) => {
        memory.addClassAt(address);
        setActiveView("memory");
        props.onClose();
    };

    // Follow the RIP-relative reference at the hit (skip the mov/lea/call, land on its target)
    // and spawn a class there. Leaves the results in place and flags a warning on failure.
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
        const len = 4; // disp32 is 4 bytes
        if (offset >= 0 && offset + len <= tokens.length) {
            for (let i = offset; i < offset + len; i++) {
                tokens[i] = "??";
            }
            setPattern(tokens.join(" "));
        }
    };

    const title = () => "Signature scan";

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
    // Cap the rendered list; a find-all can return thousands and we only need a workable preview.
    const HIT_LIMIT = 64;
    const hits = () => {
        const r = result();
        return r.status === "done" ? r.hits.slice(0, HIT_LIMIT) : [];
    };

    return (
        <section class="scan-card panel">
            <header class="panel-head">
                <h2>{title()}</h2>
                <span class="meta" />
                <button onClick={scan} disabled={!canScan()}>
                    {scanning() ? "scanning…" : "scan"}
                </button>
            </header>

            <div class="scan-controls">
                <input
                    class="scan-input"
                    type="text"
                    placeholder={"48 8B ?? ?? E8"}
                    value={pattern()}
                    onInput={(e) => setPattern(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && scan()}
                />

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
                    <For each={hits()}>
                        {(address) => (
                            <div class="row scan-hit">
                                <span class="addr grow">{address}</span>
                                <button onClick={() => createClass(address)}>create class</button>
                                <button
                                    title="follow the RIP-relative reference here and create a class at its target"
                                    onClick={() => followToClass(address)}
                                >
                                    follow ref
                                </button>
                            </div>
                        )}
                    </For>
                </div>
                <StatusOverlay message={overlayMessage()} error={result().status === "error"} />
            </div>
        </section>
    );
}
