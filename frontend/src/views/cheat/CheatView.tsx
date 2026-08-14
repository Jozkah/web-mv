import { For, Show, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import { useApp } from "../../app/AppContext";
import { createPoll } from "../../polling/createPoll";
import { read, readBatch, write } from "../../protocol/requests";
import { resolveLabel } from "../../state/labels";
import { downloadText, pickTextFile } from "../../state/fileio";
import { errorText } from "../../state/errors";
import type { CheatEntry } from "../../state/cheatStore";
import { decodeValue, encodeValue, byteWidth, VALUE_TYPES, type ValueType } from "./valueCodec";
import "./cheat.css";

// The Cheat Table view. The persisted entry list lives in the shared cheat store (so other views
// can send addresses here); this view owns the live read/freeze poll and the write path.

interface LiveCell {
    display: string;
    hex: string;
    ok: boolean;
}

const POLL_MS = 500;

export function CheatView() {
    const { client, attached, modules, cheat } = useApp();

    // Live value per entry id, refreshed by the poll below (ephemeral — not persisted).
    const [live, setLive] = createStore<Record<string, LiveCell>>({});
    const [pollError, setPollError] = createSignal<string>();

    // Add-row form state.
    const [addrInput, setAddrInput] = createSignal("");
    const [typeInput, setTypeInput] = createSignal<ValueType>("i32");
    const [descInput, setDescInput] = createSignal("");

    // Display integer values in hex instead of decimal, and the currently selected row (for the
    // freeze/delete hotkeys). Selection is view-only, so it lives here rather than in the store.
    const [hexView, setHexView] = createSignal(false);
    const [selectedId, setSelectedId] = createSignal<string>();

    const isFloat = (t: ValueType) => t === "f32" || t === "f64";
    const formatValue = (e: CheatEntry): string => {
        const cell = live[e.id];
        if (!cell) return "…";
        if (!cell.ok) return "—";
        if (hexView() && !isFloat(e.type)) {
            try {
                const n = BigInt(cell.display);
                return n < 0n ? "-0x" + (-n).toString(16) : "0x" + n.toString(16);
            } catch {
                return cell.display;
            }
        }
        return cell.display;
    };

    // Per-row "set value" draft, keyed by entry id.
    const [drafts, setDrafts] = createStore<Record<string, string>>({});
    const [rowError, setRowError] = createSignal<{ id: string; msg: string }>();
    // Last explicit write, kept so it can be undone (restores the bytes that were there before).
    const [lastWrite, setLastWrite] = createSignal<{ address: string; priorHex: string; label: string }>();

    const tick = async () => {
        const entries = cheat.entries;
        if (entries.length === 0) return;
        try {
            const res = await readBatch(client, {
                reads: entries.map((e) => ({ address: e.address, size: byteWidth(e.type) })),
            });
            setPollError(undefined);
            res.results.forEach((r, i) => {
                const e = entries[i];
                if (!e) return;
                const display = r.success ? decodeValue(r.data, e.type) : "—";
                // Keep the last good hex on a failed read so a later freeze can't capture garbage.
                setLive(e.id, { display, hex: r.success ? r.data : (live[e.id]?.hex ?? ""), ok: r.success });
            });
            for (const e of entries) {
                const cell = live[e.id];
                // Late-capture: a row frozen before its first successful read has no target yet.
                if (e.frozen && !e.frozenHex && cell?.ok) {
                    cheat.setFrozenHex(e.id, cell.hex);
                }
                // Re-apply frozen values after reading (so the read reflects our own write next tick).
                if (e.frozen && e.frozenHex) {
                    await write(client, { address: e.address, data: e.frozenHex }).catch(() => {});
                }
            }
        } catch (e) {
            setPollError(errorText(e));
        }
    };

    createPoll(tick, POLL_MS, attached);

    const addEntry = () => {
        const id = cheat.add(addrInput(), typeInput(), descInput());
        if (id === undefined) return; // invalid address
        setAddrInput("");
        setDescInput("");
    };

    const setValue = async (e: CheatEntry) => {
        const draft = drafts[e.id];
        if (draft === undefined || draft === "") return;
        try {
            const hex = encodeValue(draft, e.type);
            // Capture the bytes we're about to overwrite (same width as the value) so this write
            // can be undone. Only usable if the last read of this row succeeded and matches width.
            const prior = live[e.id];
            const res = await write(client, { address: e.address, data: hex });
            if (!res.success) {
                setRowError({ id: e.id, msg: "write failed (protected page?)" });
                return;
            }
            setRowError(undefined);
            if (prior?.ok && prior.hex.length === hex.length) {
                setLastWrite({ address: e.address, priorHex: prior.hex, label: e.desc || e.address });
            }
            // If frozen, update the frozen target to the new value.
            if (e.frozen) cheat.setFrozenHex(e.id, hex);
            setDrafts(e.id, "");
            // Echo-verify: re-read and warn if the value didn't stick (the game likely owns it).
            const back = await read(client, { address: e.address, size: byteWidth(e.type) });
            if (back.success && back.data !== hex) {
                setRowError({ id: e.id, msg: "written, but re-read differs — game may control this" });
            }
        } catch (err) {
            setRowError({ id: e.id, msg: errorText(err) });
        }
    };

    const undoLastWrite = async () => {
        const lw = lastWrite();
        if (!lw) return;
        try {
            await write(client, { address: lw.address, data: lw.priorHex });
        } catch {
            /* best-effort restore */
        }
        setLastWrite(undefined);
    };

    const toggleFreeze = (e: CheatEntry) => {
        const cell = live[e.id];
        cheat.toggleFreeze(e.id, cell?.ok ? cell.hex : undefined);
    };

    // Keyboard shortcuts on the selected row: F toggles freeze, Delete removes it. Ignored while
    // typing in a field so the add/set inputs keep working normally.
    onMount(() => {
        const onKey = (ev: KeyboardEvent) => {
            const el = ev.target as HTMLElement | null;
            if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
            const id = selectedId();
            if (!id) return;
            const entry = cheat.entries.find((x) => x.id === id);
            if (!entry) return;
            if (ev.key === "f" || ev.key === "F") {
                ev.preventDefault();
                toggleFreeze(entry);
            } else if (ev.key === "Delete") {
                ev.preventDefault();
                cheat.remove(id);
            }
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    const doImport = async () => {
        const text = await pickTextFile();
        if (text === undefined) return;
        try {
            const n = cheat.importJson(text);
            setPollError(n > 0 ? undefined : "no valid entries in file");
        } catch (err) {
            setPollError(errorText(err));
        }
    };

    const isConnected = createMemo(() => attached());

    return (
        <div class="cheat-view">
            <div class="cheat-toolbar">
                <input
                    class="cheat-input cheat-addr"
                    placeholder="address (0x...)"
                    value={addrInput()}
                    onInput={(ev) => setAddrInput(ev.currentTarget.value)}
                    onKeyDown={(ev) => ev.key === "Enter" && addEntry()}
                />
                <select
                    class="cheat-input"
                    value={typeInput()}
                    onChange={(ev) => setTypeInput(ev.currentTarget.value as ValueType)}
                >
                    <For each={VALUE_TYPES}>{(t) => <option value={t}>{t}</option>}</For>
                </select>
                <input
                    class="cheat-input cheat-desc"
                    placeholder="description"
                    value={descInput()}
                    onInput={(ev) => setDescInput(ev.currentTarget.value)}
                    onKeyDown={(ev) => ev.key === "Enter" && addEntry()}
                />
                <button class="cheat-btn" onClick={addEntry}>+ Add</button>
                <button
                    class="cheat-btn ghost"
                    classList={{ active: hexView() }}
                    title="Toggle hex / decimal value display"
                    onClick={() => setHexView((v) => !v)}
                >
                    {hexView() ? "hex" : "dec"}
                </button>
                <Show when={lastWrite()}>
                    {(lw) => (
                        <button class="cheat-btn ghost" title={`Restore previous bytes at ${lw().address}`} onClick={undoLastWrite}>
                            ↶ Undo write
                        </button>
                    )}
                </Show>
                <button class="cheat-btn ghost" title="Export cheat table to JSON" onClick={() => downloadText("cheat-table.json", cheat.exportJson())}>⭳</button>
                <button class="cheat-btn ghost" title="Import cheat table from JSON" onClick={doImport}>⭱</button>
                <Show when={!isConnected()}>
                    <span class="cheat-warn">agent not attached</span>
                </Show>
                <Show when={pollError()}>
                    <span class="cheat-warn">{pollError()}</span>
                </Show>
            </div>

            <Show
                when={cheat.entries.length > 0}
                fallback={<div class="cheat-empty">No entries. Add an address above, or use “→ Cheat” from the strings / scan / PE views.</div>}
            >
                <table class="cheat-table">
                    <thead>
                        <tr>
                            <th class="col-freeze">🔒</th>
                            <th class="col-desc">Description</th>
                            <th class="col-addr">Address</th>
                            <th class="col-type">Type</th>
                            <th class="col-value">Value</th>
                            <th class="col-set">Set</th>
                            <th class="col-rm" />
                        </tr>
                    </thead>
                    <tbody>
                        <For each={cheat.entries}>
                            {(e) => (
                                <tr
                                    classList={{ frozen: e.frozen, selected: selectedId() === e.id }}
                                    onClick={() => setSelectedId(e.id)}
                                >
                                    <td class="col-freeze">
                                        <input
                                            type="checkbox"
                                            checked={e.frozen}
                                            onChange={() => toggleFreeze(e)}
                                            title="Freeze value"
                                        />
                                    </td>
                                    <td class="col-desc">{e.desc || <span class="muted">—</span>}</td>
                                    <td class="col-addr mono" title={resolveLabel(e.address, modules.list())}>{e.address}</td>
                                    <td class="col-type mono">{e.type}</td>
                                    <td class="col-value mono">
                                        <span classList={{ bad: live[e.id]?.ok === false }}>
                                            {formatValue(e)}
                                        </span>
                                    </td>
                                    <td class="col-set">
                                        <input
                                            class="cheat-input cheat-setval"
                                            placeholder="value"
                                            value={drafts[e.id] ?? ""}
                                            onInput={(ev) => setDrafts(e.id, ev.currentTarget.value)}
                                            onKeyDown={(ev) => ev.key === "Enter" && setValue(e)}
                                        />
                                        <button class="cheat-btn small" onClick={() => setValue(e)}>Set</button>
                                        <Show when={rowError()?.id === e.id}>
                                            <span class="cheat-warn small">{rowError()?.msg}</span>
                                        </Show>
                                    </td>
                                    <td class="col-rm">
                                        <button class="cheat-btn ghost tiny" title="Move up" onClick={(ev) => { ev.stopPropagation(); cheat.move(e.id, -1); }}>↑</button>
                                        <button class="cheat-btn ghost tiny" title="Move down" onClick={(ev) => { ev.stopPropagation(); cheat.move(e.id, 1); }}>↓</button>
                                        <button class="cheat-btn ghost" title="Remove (Del)" onClick={(ev) => { ev.stopPropagation(); cheat.remove(e.id); }}>×</button>
                                    </td>
                                </tr>
                            )}
                        </For>
                    </tbody>
                </table>
            </Show>
        </div>
    );
}
