import { For, Show, createSignal, createMemo } from "solid-js";
import { useApp } from "../../app/AppContext";
import { createPoll } from "../../polling/createPoll";
import { read } from "../../protocol/requests";
import { errorText } from "../../state/errors";
import "./diff.css";

// Snapshot diff: capture a memory region as a baseline, then re-read it and show which bytes
// changed. The classic "freeze a baseline, do something in-game, see what moved" workflow —
// a poor man's value scanner scoped to one region (the dedicated Scanner tab is the full version).

const MAX_SIZE = 4096; // agent bounds a single read; keep the region modest

interface DiffRow {
    offset: number;
    address: string;
    before: string; // 2-hex
    after: string;
}

function hexToBytes(hex: string): number[] {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out: number[] = [];
    for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
    return out;
}

function normalizeAddr(input: string): string {
    const s = input.trim().replace(/\s+/g, "");
    const hex = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
    return "0x" + hex.toLowerCase();
}

const MAX_BULK_ADD = 64; // cap "add all changed" so a big diff can't flood the cheat table

export function SnapshotDiffView() {
    const { client, attached, cheat } = useApp();
    const [addrInput, setAddrInput] = createSignal("");
    const [sizeInput, setSizeInput] = createSignal("256");
    const [baseline, setBaseline] = createSignal<string>();
    const [current, setCurrent] = createSignal<string>();
    const [baseAddr, setBaseAddr] = createSignal("");
    // The region the baseline was captured from, snapshotted so later edits to the address/size
    // inputs can't retarget the diff (or crash it) mid-flight.
    const [baseRegion, setBaseRegion] = createSignal<{ address: string; size: number }>();
    const [error, setError] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    const [autoPoll, setAutoPoll] = createSignal(false);
    const AUTO_POLL_MS = 500;

    const region = () => {
        const address = normalizeAddr(addrInput());
        if (!/^0x[0-9a-f]+$/.test(address)) return undefined;
        const size = Math.min(Math.max(1, parseInt(sizeInput(), 10) || 0), MAX_SIZE);
        return { address, size };
    };

    // Read a specific region (captured up-front by the caller), never the live inputs.
    const doRead = async (r: { address: string; size: number }): Promise<string | undefined> => {
        setError(undefined);
        setBusy(true);
        try {
            const res = await read(client, r);
            return res.data;
        } catch (e) {
            setError(errorText(e));
            return undefined;
        } finally {
            setBusy(false);
        }
    };

    const capture = async () => {
        const r = region();
        if (!r) {
            setError("enter a valid address");
            return;
        }
        const data = await doRead(r);
        if (data === undefined) return;
        setBaseRegion(r);
        setBaseAddr(r.address);
        setBaseline(data);
        setCurrent(undefined);
    };

    const diffNow = async () => {
        const r = baseRegion();
        if (r === undefined) return; // diff always targets the captured baseline region
        const data = await doRead(r);
        if (data === undefined) return;
        setCurrent(data);
    };

    // Auto-poll: while enabled (and a baseline exists), re-diff on a cadence so changed bytes light
    // up live as they move in-game — no repeated "Diff now" clicks. Gated so it costs nothing when
    // off, detached, or before a baseline is captured.
    createPoll(
        () => (baseRegion() ? diffNow() : Promise.resolve()),
        AUTO_POLL_MS,
        () => attached() && autoPoll() && baseRegion() !== undefined,
    );

    const rows = createMemo<DiffRow[]>(() => {
        const b = baseline();
        const c = current();
        if (b === undefined || c === undefined) return [];
        const ba = hexToBytes(b);
        const ca = hexToBytes(c);
        const base = BigInt(baseAddr() || "0x0");
        const n = Math.min(ba.length, ca.length);
        const out: DiffRow[] = [];
        for (let i = 0; i < n; i++) {
            if (ba[i] !== ca[i]) {
                out.push({
                    offset: i,
                    address: "0x" + (base + BigInt(i)).toString(16),
                    before: ba[i].toString(16).padStart(2, "0"),
                    after: ca[i].toString(16).padStart(2, "0"),
                });
            }
        }
        return out;
    });

    return (
        <div class="diff-view">
            <div class="diff-toolbar">
                <input
                    class="diff-input diff-addr"
                    placeholder="address (0x...)"
                    value={addrInput()}
                    onInput={(e) => setAddrInput(e.currentTarget.value)}
                />
                <input
                    class="diff-input diff-size"
                    placeholder="bytes"
                    value={sizeInput()}
                    onInput={(e) => setSizeInput(e.currentTarget.value)}
                    title={`max ${MAX_SIZE} bytes`}
                />
                <button class="diff-btn" onClick={capture} disabled={!attached() || busy()}>Capture baseline</button>
                <button class="diff-btn" onClick={diffNow} disabled={!attached() || busy() || baseline() === undefined}>Diff now</button>
                <button
                    class="diff-btn"
                    classList={{ active: autoPoll() }}
                    disabled={baseline() === undefined}
                    title="Re-diff continuously so changes light up live"
                    onClick={() => setAutoPoll((v) => !v)}
                >
                    {autoPoll() ? "⏸ auto" : "▶ auto"}
                </button>
                <Show when={error()}><span class="diff-warn">{error()}</span></Show>
                <Show when={!attached()}><span class="diff-warn">agent not attached</span></Show>
            </div>

            <Show when={baseline() !== undefined}>
                <div class="diff-status">
                    Baseline captured at <span class="mono">{baseAddr()}</span> ({hexToBytes(baseline()!).length} bytes).
                    <Show when={current() !== undefined} fallback={<span> Press “Diff now” after the value changes.</span>}>
                        <span> {rows().length} byte(s) changed.</span>
                    </Show>
                </div>
            </Show>

            <Show when={current() !== undefined && rows().length > 0}>
                <div class="diff-actions">
                    <button
                        class="diff-btn"
                        onClick={() => rows().slice(0, MAX_BULK_ADD).forEach((r) => cheat.add(r.address, "u8", "diff"))}
                    >
                        → Cheat Table (first {Math.min(rows().length, MAX_BULK_ADD)} as u8)
                    </button>
                </div>
                <table class="diff-table">
                    <thead><tr><th>Offset</th><th>Address</th><th>Before</th><th>After</th><th /></tr></thead>
                    <tbody>
                        <For each={rows()}>
                            {(r) => (
                                <tr>
                                    <td class="mono">+0x{r.offset.toString(16)}</td>
                                    <td class="mono">{r.address}</td>
                                    <td class="mono before">{r.before}</td>
                                    <td class="mono after">{r.after}</td>
                                    <td>
                                        <button class="diff-pin" title="Add to Cheat Table (u8)" onClick={() => cheat.add(r.address, "u8", "diff")}>📌</button>
                                    </td>
                                </tr>
                            )}
                        </For>
                    </tbody>
                </table>
            </Show>
            <Show when={current() !== undefined && rows().length === 0}>
                <div class="diff-empty">No bytes changed in this region.</div>
            </Show>
        </div>
    );
}
