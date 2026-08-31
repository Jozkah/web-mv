import { For, Show, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { useNavigation } from "../../app/useNavigation";
import { createPoll } from "../../polling/createPoll";
import { read } from "../../protocol/requests";
import { resolveGotoInput } from "../../app/useNavigation";
import { resolveLabel } from "../../state/labels";
import { errorText } from "../../state/errors";
import { decodeValue, byteWidth, VALUE_TYPES, type ValueType } from "../cheat/valueCodec";
import { discoverPointerChains } from "../../scan/pointerScan";
import type { ModuleRange, PointerChain } from "../../scan/pointerChain";
import "../pe/pe.css";
import "./pointer.css";

// Bounded pointer-chain resolver. Given a base (address or module+offset) and a list of offsets,
// it walks `addr = *addr + offset` for each level and shows every hop plus the final address and
// its value. This is chain-following (a handful of 8-byte reads), NOT scanning - safe and instant.
// Auto-resolve re-walks on a cadence so the final address/value stay live as the game moves them.

interface Hop {
    level: number;
    address: string;
    deref: string; // pointer read at this address ("—" if unreadable)
}

function parseOffsets(text: string): bigint[] | undefined {
    const parts = text.trim().split(/[\s,]+/).filter(Boolean);
    const out: bigint[] = [];
    for (const p of parts) {
        try {
            out.push(BigInt(/^0x/i.test(p) || /[a-f]/i.test(p) ? (p.startsWith("0x") ? p : "0x" + p) : p));
        } catch {
            return undefined;
        }
    }
    return out;
}

export function PointerView() {
    const { client, attached, modules, cheat, capabilities } = useApp();
    const nav = useNavigation();

    // --- pointer-chain discovery (angel-derived, bounded/scoped) ---
    const [discTarget, setDiscTarget] = createSignal("");
    const [discModule, setDiscModule] = createSignal("");
    const [discDepth, setDiscDepth] = createSignal(3);
    const [discOffset, setDiscOffset] = createSignal("0x400");
    const [discChains, setDiscChains] = createSignal<PointerChain[]>([]);
    const [discBusy, setDiscBusy] = createSignal(false);
    const [discInfo, setDiscInfo] = createSignal<string>();
    const pointerCap = () => capabilities.available("scan.pointer");

    const readChunk = async (address: bigint, size: number): Promise<Uint8Array | undefined> => {
        const res = await read(client, { address: "0x" + address.toString(16), size });
        if (!res.success) return undefined;
        const hex = res.data.replace(/^0x/, "");
        const out = new Uint8Array(hex.length >> 1);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return out;
    };

    const discover = async () => {
        const t = resolveGotoInput(discTarget(), modules.list());
        if (!t) { setDiscInfo("invalid target address"); return; }
        const mods: ModuleRange[] = modules.list().map((m) => ({ name: m.name, base: BigInt(m.base), size: BigInt(m.size) }));
        const scan = discModule() ? mods.find((m) => m.name === discModule()) : mods[0];
        if (!scan) { setDiscInfo("no module to scan"); return; }
        setDiscBusy(true);
        setDiscInfo("scanning…");
        setDiscChains([]);
        try {
            const res = await discoverPointerChains(readChunk, {
                target: BigInt(t.address),
                region: { base: scan.base, size: scan.size },
                modules: mods,
                maxDepth: discDepth(),
                maxOffset: BigInt(discOffset().startsWith("0x") ? discOffset() : "0x" + discOffset()),
                maxResults: 200,
                byteBudget: 8 * 1024 * 1024,
            });
            setDiscChains(res.chains);
            setDiscInfo(`${res.chains.length} chains · ${(res.bytesScanned / 1024 / 1024).toFixed(1)} MiB scanned${res.truncated ? " (byte budget hit — scoped result)" : ""}`);
        } catch (e) {
            setDiscInfo(errorText(e));
        } finally {
            setDiscBusy(false);
        }
    };

    const useChain = (c: PointerChain) => {
        setBaseInput(c.baseModule ? `${c.baseModule}+${c.baseRva}` : c.baseAddress);
        setOffsetsInput(c.offsets.join(" "));
        resolve();
    };

    const [baseInput, setBaseInput] = createSignal("");
    const [offsetsInput, setOffsetsInput] = createSignal("");
    const [type, setType] = createSignal<ValueType>("i32");
    const [hops, setHops] = createSignal<Hop[]>([]);
    const [finalAddr, setFinalAddr] = createSignal<string>();
    const [value, setValue] = createSignal<string>();
    const [error, setError] = createSignal<string>();
    const [auto, setAuto] = createSignal(false);

    const readU64 = async (addr: bigint): Promise<bigint | undefined> => {
        const res = await read(client, { address: "0x" + addr.toString(16), size: 8 });
        if (!res.success) return undefined;
        const bytes = res.data.replace(/^0x/, "");
        let v = 0n;
        for (let i = 0; i < 8; i++) v |= BigInt(parseInt(bytes.slice(i * 2, i * 2 + 2), 16) || 0) << BigInt(i * 8);
        return v;
    };

    const resolve = async () => {
        const b = resolveGotoInput(baseInput(), modules.list());
        if (!b) { setError("invalid base (address or module+offset)"); return; }
        const offs = parseOffsets(offsetsInput());
        if (!offs) { setError("invalid offsets (hex, space/comma separated)"); return; }
        setError(undefined);

        let addr = BigInt(b.address);
        const trail: Hop[] = [];
        for (let i = 0; i < offs.length; i++) {
            const p = await readU64(addr);
            trail.push({ level: i, address: "0x" + addr.toString(16), deref: p === undefined ? "—" : "0x" + p.toString(16) });
            if (p === undefined) { setHops(trail); setFinalAddr(undefined); setValue(undefined); return; }
            addr = p + offs[i];
        }
        const final = "0x" + addr.toString(16);
        setHops(trail);
        setFinalAddr(final);
        const res = await read(client, { address: final, size: byteWidth(type()) });
        setValue(res.success ? decodeValue(res.data, type()) : "—");
    };

    createPoll(() => (finalAddr() || baseInput() ? resolve() : Promise.resolve()), 500, () => attached() && auto());

    return (
        <div class="pe-view">
            <div class="pe-toolbar">
                <input class="pe-input pt-base" placeholder="base: 0x… or game.dll+0x1234" value={baseInput()} onInput={(e) => setBaseInput(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && resolve()} />
                <input class="pe-input pt-offs" placeholder="offsets: 0x10 0x8 0x0" value={offsetsInput()} onInput={(e) => setOffsetsInput(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && resolve()} />
                <select class="pe-input" value={type()} onChange={(e) => setType(e.currentTarget.value as ValueType)}>
                    <For each={VALUE_TYPES}>{(t) => <option value={t}>{t}</option>}</For>
                </select>
                <button class="pe-btn sc-primary" onClick={resolve} disabled={!attached()}>Resolve</button>
                <button class="pe-btn" classList={{ active: auto() }} onClick={() => setAuto((v) => !v)} title="Re-resolve continuously">{auto() ? "⏸ auto" : "▶ auto"}</button>
                <Show when={!attached()}><span class="pe-warn">agent not attached</span></Show>
                <Show when={error()}><span class="pe-warn">{error()}</span></Show>
            </div>

            <Show when={finalAddr()}>
                {(fa) => (
                    <div class="pt-result">
                        <span class="pt-label">final</span>
                        <span class="mono pt-final">{fa()}</span>
                        <span class="mono dim">{resolveLabel(fa(), modules.list())}</span>
                        <span class="pt-label">=</span>
                        <span class="mono pt-value">{value() ?? "…"}</span>
                        <span class="mono dim">({type()})</span>
                        <button class="pe-btn small" onClick={() => cheat.add(fa(), type(), "ptr")}>➕ cheat</button>
                        <button class="pe-btn small" onClick={() => nav.goto("memory", fa(), resolveLabel(fa(), modules.list()))}>🧠</button>
                        <button class="pe-btn small" onClick={() => nav.goto("static", fa(), resolveLabel(fa(), modules.list()))}>⚡</button>
                    </div>
                )}
            </Show>

            <div class="pt-body">
                <Show when={hops().length > 0}>
                    <table class="pe-table">
                        <thead><tr><th>Level</th><th>Address (read here)</th><th>→ pointer</th></tr></thead>
                        <tbody>
                            <For each={hops()}>
                                {(h) => (
                                    <tr classList={{ bad: h.deref === "—" }}>
                                        <td class="mono">[{h.level}]</td>
                                        <td class="mono">{h.address}</td>
                                        <td class="mono">{h.deref}</td>
                                    </tr>
                                )}
                            </For>
                        </tbody>
                    </table>
                </Show>
            </div>

            <div class="pt-discover">
                <div class="pt-disc-head">
                    Discover chains
                    <span class="pt-disc-hint">reverse pointer scan — bounded, scoped to one module (a snapshot heuristic, not a live find-writer)</span>
                </div>
                <div class="pe-toolbar">
                    <input class="pe-input pt-base" placeholder="target: 0x… or module+0x…" value={discTarget()} onInput={(e) => setDiscTarget(e.currentTarget.value)} />
                    <select class="pe-input" value={discModule()} onChange={(e) => setDiscModule(e.currentTarget.value)} title="Module region to scan for pointers">
                        <option value="">(main module)</option>
                        <For each={modules.list()}>{(m) => <option value={m.name}>{m.name}</option>}</For>
                    </select>
                    <span class="pe-note">depth <input class="pt-num" type="number" min="1" max="6" value={discDepth()} onInput={(e) => setDiscDepth(Number(e.currentTarget.value))} /></span>
                    <span class="pe-note">max off <input class="pt-num" value={discOffset()} onInput={(e) => setDiscOffset(e.currentTarget.value)} /></span>
                    <button class="pe-btn sc-primary" disabled={!attached() || !pointerCap() || discBusy()} onClick={discover} title={pointerCap() ? "" : "Requires memory.read (core agent)"}>
                        {discBusy() ? "scanning…" : "Discover"}
                    </button>
                    <Show when={discInfo()}><span class="pe-note">{discInfo()}</span></Show>
                </div>
                <Show when={discChains().length > 0}>
                    <table class="pe-table">
                        <thead><tr><th>Base</th><th>Offsets</th><th>Depth</th><th /></tr></thead>
                        <tbody>
                            <For each={discChains()}>
                                {(c) => (
                                    <tr>
                                        <td class="mono">{c.baseModule ? `${c.baseModule}+${c.baseRva}` : c.baseAddress}</td>
                                        <td class="mono dim">{c.offsets.join(", ")}</td>
                                        <td class="mono">{c.depth}</td>
                                        <td><button class="pe-btn small" onClick={() => useChain(c)} title="Load this chain into the resolver above">Use</button></td>
                                    </tr>
                                )}
                            </For>
                        </tbody>
                    </table>
                </Show>
            </div>
        </div>
    );
}
