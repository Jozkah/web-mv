import { For, Show, createMemo } from "solid-js";
import { useApp } from "../../app/AppContext";
import { makeModuleLookup, resolveWatchAddress } from "../../watch/resolve";
import {
    ALLOWED_INTERVALS_MS,
    isStringType,
    type WatchComparisonBasis,
    type WatchComparisonMode,
    type WatchDisplayBase,
    type WatchValueType,
} from "../../watch/model";

// Detail inspector / editor for one watch: entered expression vs resolved address (shown
// separately), typed configuration, comparison/trigger predicate, live status + raw bytes, and a
// bounded history table. All edits go through the store's validated update().

const MODES: WatchComparisonMode[] = [
    "changed", "unchanged", "increased", "decreased", "increasedBy", "decreasedBy",
    "equal", "notEqual", "greater", "less", "greaterEqual", "lessEqual", "range",
    "crossedUp", "crossedDown", "bitChanged", "bitSet", "bitCleared",
    "pointerChanged", "bytePatternChanged", "stringChanged", "stringContains", "structureBytesChanged",
];
const BASES: WatchComparisonBasis[] = ["previous", "baseline", "constant"];
const DISPLAY_BASES: WatchDisplayBase[] = ["auto", "hex", "decimal", "binary", "char"];

export function WatchInspector(props: { id: string; onClose: () => void }) {
    const app = useApp();
    const w = app.watches;
    const def = () => w.byId(props.id)!;
    const rt = () => w.runtime(props.id);

    const resolvedPreview = createMemo(() => {
        const lookup = makeModuleLookup(app.modules.list().map((m) => ({ name: m.name, base: m.base })));
        return resolveWatchAddress(def().expression, lookup);
    });

    const history = () => w.historyOf(props.id);
    const patch = (p: Parameters<typeof w.update>[1]) => w.update(props.id, p);

    return (
        <div class="mw-inspector">
            <div class="mw-insp-head">
                <input class="mw-insp-name" value={def().name} onChange={(e) => patch({ name: e.currentTarget.value })} aria-label="Watch name" />
                <button class="mw-btn" onClick={props.onClose} title="Close inspector">×</button>
            </div>

            <div class="mw-insp-grid">
                <label>Expression</label>
                <input value={def().expression} onChange={(e) => patch({ expression: e.currentTarget.value })} />

                <label>Resolved</label>
                <span class="mw-mono">
                    <Show when={resolvedPreview().ok} fallback={<span class="mw-bad">{resolvedPreview().error}</span>}>
                        {resolvedPreview().address}
                        <Show when={resolvedPreview().relocationRisk}> <span class="mw-warn-tag" title="Absolute address — moves on re-attach / ASLR">reloc risk</span></Show>
                        <Show when={resolvedPreview().moduleRef}> <span class="mw-dim">({resolvedPreview().moduleRef!.module}+{resolvedPreview().moduleRef!.offset})</span></Show>
                    </Show>
                </span>

                <label>Type</label>
                <select value={def().valueType} onChange={(e) => patch({ valueType: e.currentTarget.value as WatchValueType })}>
                    <For each={["int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64", "bool", "pointer", "bytes", "ascii", "utf8", "utf16le", "utf16be"]}>
                        {(t) => <option value={t}>{t}</option>}
                    </For>
                </select>

                <Show when={isStringType(def().valueType) || def().valueType === "bytes"}>
                    <label>Byte length</label>
                    <input type="number" min="1" value={def().byteLength ?? 16} onChange={(e) => patch({ byteLength: Number(e.currentTarget.value) })} />
                </Show>

                <label>Endianness</label>
                <select value={def().endianness} onChange={(e) => patch({ endianness: e.currentTarget.value as "little" | "big" })}>
                    <option value="little">little</option>
                    <option value="big">big</option>
                </select>

                <label>Display base</label>
                <select value={def().displayBase} onChange={(e) => patch({ displayBase: e.currentTarget.value as WatchDisplayBase })}>
                    <For each={DISPLAY_BASES}>{(b) => <option value={b}>{b}</option>}</For>
                </select>

                <label>Interval</label>
                <select value={def().intervalMs} onChange={(e) => patch({ intervalMs: Number(e.currentTarget.value) })}>
                    <For each={ALLOWED_INTERVALS_MS}>{(ms) => <option value={ms}>{ms}ms</option>}</For>
                </select>

                <label>History limit</label>
                <input type="number" min="16" max="4096" value={def().historyLimit} onChange={(e) => patch({ historyLimit: Number(e.currentTarget.value) })} />

                <label>Tags</label>
                <input value={def().tags.join(", ")} onChange={(e) => patch({ tags: e.currentTarget.value.split(",").map((t) => t.trim()).filter(Boolean) })} />

                <label>Emit changes</label>
                <input type="checkbox" checked={def().emitChangeEvents ?? true} onChange={(e) => patch({ emitChangeEvents: e.currentTarget.checked })} />
            </div>

            <div class="mw-insp-sub">Comparison predicate</div>
            <div class="mw-insp-grid">
                <label>Mode</label>
                <select value={def().predicate?.mode ?? "changed"} onChange={(e) => patch({ predicate: { mode: e.currentTarget.value as WatchComparisonMode, basis: def().predicate?.basis ?? "previous", operand: def().predicate?.operand, operandHigh: def().predicate?.operandHigh, bitIndex: def().predicate?.bitIndex, epsilon: def().predicate?.epsilon } })}>
                    <For each={MODES}>{(m) => <option value={m}>{m}</option>}</For>
                </select>
                <label>Basis</label>
                <select value={def().predicate?.basis ?? "previous"} onChange={(e) => patch({ predicate: { mode: def().predicate?.mode ?? "changed", basis: e.currentTarget.value as WatchComparisonBasis, operand: def().predicate?.operand, operandHigh: def().predicate?.operandHigh } })}>
                    <For each={BASES}>{(b) => <option value={b}>{b}</option>}</For>
                </select>
                <label>Operand</label>
                <input value={def().predicate?.operand ?? ""} placeholder="constant / threshold / substring" onChange={(e) => patch({ predicate: { mode: def().predicate?.mode ?? "changed", basis: def().predicate?.basis ?? "constant", operand: e.currentTarget.value, operandHigh: def().predicate?.operandHigh } })} />
            </div>

            <div class="mw-insp-sub">Trigger</div>
            <div class="mw-insp-grid">
                <label>Enabled</label>
                <input type="checkbox" checked={def().trigger?.enabled ?? false} onChange={(e) => patch({ trigger: { enabled: e.currentTarget.checked, everySample: def().trigger?.everySample ?? false, cooldownMs: def().trigger?.cooldownMs ?? 0, consecutive: def().trigger?.consecutive ?? 1, oneShot: def().trigger?.oneShot ?? false, severity: def().trigger?.severity ?? "notice", actions: def().trigger?.actions ?? ["timelineEvent", "flag"] } })} />
                <Show when={def().trigger}>
                    <label>Every sample</label>
                    <input type="checkbox" checked={def().trigger!.everySample} onChange={(e) => patch({ trigger: { ...def().trigger!, everySample: e.currentTarget.checked } })} />
                    <label>Cooldown ms</label>
                    <input type="number" min="0" value={def().trigger!.cooldownMs} onChange={(e) => patch({ trigger: { ...def().trigger!, cooldownMs: Number(e.currentTarget.value) } })} />
                    <label>Consecutive</label>
                    <input type="number" min="1" value={def().trigger!.consecutive} onChange={(e) => patch({ trigger: { ...def().trigger!, consecutive: Number(e.currentTarget.value) } })} />
                    <label>One-shot</label>
                    <input type="checkbox" checked={def().trigger!.oneShot} onChange={(e) => patch({ trigger: { ...def().trigger!, oneShot: e.currentTarget.checked } })} />
                </Show>
            </div>

            <div class="mw-insp-actions">
                <button class="mw-btn" onClick={() => w.readNow([props.id])}>Read now</button>
                <button class="mw-btn" onClick={() => w.captureBaseline(props.id)}>Capture baseline</button>
                <button class="mw-btn" onClick={() => w.resetTrigger(props.id)}>Reset trigger</button>
                <button class="mw-btn" onClick={() => w.clearHistory(props.id)}>Clear history</button>
                <Show when={w.isPending(props.id)}>
                    <button class="mw-btn warn" onClick={() => w.arm(props.id)} title="Arm this saved watch against the current target">Arm</button>
                </Show>
                <button class="mw-btn danger" onClick={() => { w.remove(props.id); props.onClose(); }}>Remove</button>
            </div>

            <div class="mw-insp-status">
                <span>Status: <b>{rt().status}</b></span>
                <Show when={rt().baseline}><span>Baseline: <b>{rt().baseline!.display}</b></span></Show>
                <Show when={rt().current}><span>Raw: <code>{rt().current!.bytesHex}</code></span></Show>
                <Show when={rt().error}><span class="mw-bad">Error: {rt().error!.kind} — {rt().error!.message}</span></Show>
                <Show when={rt().backoffUntilMs !== undefined}><span class="mw-warn-tag">backing off</span></Show>
            </div>

            <div class="mw-insp-sub">History ({history().length}, {w.historyDroppedOf(props.id)} dropped)</div>
            <div class="mw-history">
                <For each={history().slice(-100).reverse()}>
                    {(s) => (
                        <div class="mw-hist-row" classList={{ changed: s.changed, triggered: s.triggered }}>
                            <span class="mw-hist-seq">#{s.seq}</span>
                            <span class="mw-hist-time">{new Date(s.timestamp).toLocaleTimeString()}</span>
                            <span class="mw-hist-gen" title="target generation">g{s.generation}</span>
                            <span class="mw-hist-val">{s.display}</span>
                            <Show when={s.error}><span class="mw-bad">{s.error}</span></Show>
                        </div>
                    )}
                </For>
            </div>
        </div>
    );
}
