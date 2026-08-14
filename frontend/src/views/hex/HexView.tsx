import { For, Show, createSignal, createMemo } from "solid-js";
import { useApp } from "../../app/AppContext";
import { createPoll } from "../../polling/createPoll";
import { read, write } from "../../protocol/requests";
import { resolveLabel } from "../../state/labels";
import { normalizeAddr, isValidAddr } from "../../state/cheatStore";
import { errorText } from "../../state/errors";
import "./hex.css";

// Memory Inspector: a live hex + ASCII dump of an arbitrary region, with click-to-edit bytes
// (read on a poll, single-byte write on set). The generic viewer the memory/cheat views don't
// cover — handy for eyeballing structures and patching bytes directly.

const BYTES_PER_ROW = 16;
const MAX_SIZE = 4096;
const POLL_MS = 500;

interface HexRow {
    addr: string;
    offset: number;
    bytes: (number | undefined)[]; // undefined = unread tail padding
}

function hexToBytes(hex: string): number[] {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out: number[] = [];
    for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
    return out;
}

export function HexView() {
    const { client, attached, modules } = useApp();
    const [addrInput, setAddrInput] = createSignal("");
    const [sizeInput, setSizeInput] = createSignal("256");
    const [region, setRegion] = createSignal<{ address: string; size: number }>();
    const [selected, setSelected] = createSignal<number>(); // byte offset within region
    const [editValue, setEditValue] = createSignal("");
    const [error, setError] = createSignal<string>();

    const parseRegion = () => {
        const address = normalizeAddr(addrInput());
        if (!isValidAddr(address)) return undefined;
        const size = Math.min(Math.max(1, parseInt(sizeInput(), 10) || 0), MAX_SIZE);
        return { address, size };
    };

    const load = () => {
        const r = parseRegion();
        if (!r) {
            setError("enter a valid address");
            return;
        }
        setError(undefined);
        setSelected(undefined);
        setRegion(r);
    };

    const poll = createPoll(
        async () => {
            const r = region();
            if (!r) return undefined;
            // Tag the result with the region it came from so a stale in-flight read for a
            // previous region can never be rendered under the new region's addresses.
            return { r, res: await read(client, r) };
        },
        POLL_MS,
        () => attached() && region() !== undefined,
    );

    // Only trust bytes from the currently-committed region. Returning the hex string (not a fresh
    // array) lets createMemo's identity check short-circuit when the data is unchanged, so an
    // unchanging region doesn't rebuild the grid every tick.
    const hexStr = createMemo(() => {
        const d = poll.data();
        return d && d.r === region() && d.res.success ? d.res.data : "";
    });
    const bytes = createMemo<number[]>(() => hexToBytes(hexStr()));
    const readFailed = createMemo(() => {
        const d = poll.data();
        return poll.error() !== undefined || (d !== undefined && d.r === region() && !d.res.success);
    });

    const rows = createMemo<HexRow[]>(() => {
        const r = region();
        const data = bytes();
        if (!r) return [];
        const base = BigInt(r.address);
        const out: HexRow[] = [];
        for (let off = 0; off < r.size; off += BYTES_PER_ROW) {
            const rowBytes: (number | undefined)[] = [];
            for (let i = 0; i < BYTES_PER_ROW; i++) {
                rowBytes.push(off + i < data.length ? data[off + i] : undefined);
            }
            out.push({ addr: "0x" + (base + BigInt(off)).toString(16), offset: off, bytes: rowBytes });
        }
        return out;
    });

    const selectedAddr = createMemo(() => {
        const r = region();
        const sel = selected();
        if (!r || sel === undefined) return undefined;
        return "0x" + (BigInt(r.address) + BigInt(sel)).toString(16);
    });

    const selectByte = (offset: number, value: number | undefined) => {
        setSelected(offset);
        setEditValue(value === undefined ? "" : value.toString(16).padStart(2, "0"));
    };

    const setByte = async () => {
        const addr = selectedAddr();
        if (!addr) return;
        const s = editValue().trim();
        // Strict: parseInt would accept "3g" as 0x03 and silently write the wrong byte.
        if (!/^[0-9a-fA-F]{1,2}$/.test(s)) {
            setError("byte must be 00–ff");
            return;
        }
        const v = parseInt(s, 16);
        setError(undefined);
        try {
            const res = await write(client, { address: addr, data: v.toString(16).padStart(2, "0") });
            if (!res.success) setError("write failed (protected page?)");
            else poll.refresh();
        } catch (e) {
            setError(errorText(e));
        }
    };

    const ascii = (b: number | undefined): string => (b === undefined ? " " : b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".");

    return (
        <div class="hex-view">
            <div class="hex-toolbar">
                <input
                    class="hex-input hex-addr"
                    placeholder="address (0x...)"
                    value={addrInput()}
                    onInput={(e) => setAddrInput(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && load()}
                />
                <input
                    class="hex-input hex-size"
                    placeholder="bytes"
                    value={sizeInput()}
                    onInput={(e) => setSizeInput(e.currentTarget.value)}
                    title={`max ${MAX_SIZE} bytes`}
                    onKeyDown={(e) => e.key === "Enter" && load()}
                />
                <button class="hex-btn" onClick={load} disabled={!attached()}>Go</button>
                <Show when={region()}>
                    <span class="hex-note">{resolveLabel(region()!.address, modules.list())}</span>
                </Show>
                <Show when={error()}><span class="hex-warn">{error()}</span></Show>
                <Show when={readFailed()}><span class="hex-warn">read failed</span></Show>
                <Show when={!attached()}><span class="hex-warn">agent not attached</span></Show>
            </div>

            <Show when={region()}>
                <div class="hex-grid">
                    <For each={rows()}>
                        {(row) => (
                            <div class="hex-row">
                                <span class="hex-off">{row.addr}</span>
                                <span class="hex-cells">
                                    <For each={row.bytes}>
                                        {(b, i) => (
                                            <span
                                                class="hex-cell"
                                                classList={{ sel: selected() === row.offset + i(), empty: b === undefined }}
                                                onClick={() => b !== undefined && selectByte(row.offset + i(), b)}
                                            >
                                                {b === undefined ? "  " : b.toString(16).padStart(2, "0")}
                                            </span>
                                        )}
                                    </For>
                                </span>
                                <span class="hex-ascii">
                                    <For each={row.bytes}>{(b) => <span>{ascii(b)}</span>}</For>
                                </span>
                            </div>
                        )}
                    </For>
                </div>

                <Show when={selectedAddr()}>
                    <div class="hex-edit">
                        <span class="hex-note mono">{selectedAddr()}</span>
                        <span>=</span>
                        <input
                            class="hex-input hex-byte"
                            value={editValue()}
                            onInput={(e) => setEditValue(e.currentTarget.value)}
                            onKeyDown={(e) => e.key === "Enter" && setByte()}
                            maxLength={2}
                        />
                        <button class="hex-btn small" onClick={setByte}>Set byte</button>
                    </div>
                </Show>
            </Show>
        </div>
    );
}
