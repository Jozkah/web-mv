import { For, Show, createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js";
import { useApp } from "../../../app/AppContext";
import { config } from "../../../config";
import { parseHex, toHex } from "../../../state/address";
import { read } from "../../../protocol/requests";
import { bytePairs, hexToBytes } from "../nodes/format";
import { decodeNode } from "../nodes/decode";
import { createNode, offsets, padding } from "../nodes/layout";
import { planGuesses } from "../nodes/guess";
import { fieldLength, fieldType, nodeByteSize, nodeType, type GuessField, type Node } from "../nodes/types";
import { useMemory } from "../state/MemoryContext";

// Inline pointer expansion: read the struct at a pointer's target and render its fields in place,
// indented beneath the pointer row, with a live refresh and recursive expansion of nested
// pointers. Self-contained (its own light poll, its own guessed layout) so it doesn't perturb the
// class definition or the main region poll - following a pointer into a NEW class is still the
// separate action; this is the peek-in-place variant. The poll honors the viewer's pause state:
// while paused, the last-read bytes stay frozen and no new target reads are issued.

// How much to read at the target, and how deep the recursion may go before we stop offering to
// expand further (bounds live reads and guards against pointer cycles).
const EXPAND_BYTES = 0x40;
const MAX_DEPTH = 4;

export function PointerExpansion(props: {
    address: string;
    path: string;
    depth: number;
    paused: Accessor<boolean>;
}) {
    const app = useApp();
    const memory = useMemory();

    const [view, setView] = createSignal<DataView>();
    const [nodes, setNodes] = createSignal<Node[]>([]);

    // Guess a stable field layout once per target from its first read - later ticks only refresh
    // the bytes, so field ids (and any open child expansions) stay put while values animate.
    const buildNodes = (v: DataView): Node[] => {
        const base = padding(EXPAND_BYTES);
        const plan = new Map(planGuesses(base, v).map((p) => [p.nodeId, p]));
        return base.flatMap((n) => {
            const p = plan.get(n.id);
            if (!p) return [n];
            const fields: GuessField[] = p.pointerTarget ? ["pointer"] : p.types;
            if (fields.length === 0) return [n];
            return fields.map((f) => createNode(fieldType(f), undefined, fieldLength(f)));
        });
    };

    // One light poll per expansion, restarted when the target address changes (a parent pointer
    // retargeting). Mirrors the main snapshot loop: at most one read outstanding, next tick only
    // after the current settles, abandoned on address change / unmount via `alive`. Pausing stops
    // the schedule (the nested effect below restarts it on resume); the built layout survives a
    // pause so nothing jumps when polling resumes.
    createEffect(
        on(
            () => props.address,
            (address) => {
                setView(undefined);
                setNodes([]);
                let alive = true;
                let timer: ReturnType<typeof setTimeout> | undefined;
                let inFlight = false;
                let built = false;

                const tick = () => {
                    if (!alive || inFlight || untrack(props.paused)) return;
                    inFlight = true;
                    read(app.client, { address, size: EXPAND_BYTES })
                        .then((res) => {
                            if (!alive || !res.success) return;
                            const b = hexToBytes(res.data);
                            const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
                            if (!built) {
                                setNodes(buildNodes(v));
                                built = true;
                            }
                            setView(v);
                        })
                        .catch(() => {})
                        .finally(() => {
                            inFlight = false;
                            if (alive && !untrack(props.paused)) {
                                timer = setTimeout(tick, config.memoryPollIntervalMs);
                            }
                        });
                };

                // Nested effect (owned by this computation): stop the timer on pause, kick the
                // loop again on resume. First run starts the initial read when not paused.
                createEffect(() => {
                    if (props.paused()) {
                        clearTimeout(timer);
                    } else {
                        tick();
                    }
                });

                onCleanup(() => {
                    alive = false;
                    clearTimeout(timer);
                });
            },
        ),
    );

    const offs = () => offsets(nodes());

    return (
        <div class="ptr-expand">
            <Show
                when={view()}
                fallback={
                    <div class="ptr-expand-status">
                        {props.paused() ? `paused — ${props.address} not read` : `reading ${props.address}…`}
                    </div>
                }
            >
                {(v) => (
                    <For each={nodes()}>
                        {(node, i) => {
                            const offset = () => offs()[i()];
                            const size = () => nodeByteSize(node);
                            const inBounds = () => offset() + size() <= v().byteLength;
                            const address = () => toHex(parseHex(props.address) + BigInt(offset()));
                            const value = () => (inBounds() ? decodeNode(v(), offset(), node) : undefined);
                            const target = () =>
                                node.typeId === "pointer" && inBounds()
                                    ? `0x${v().getBigUint64(offset(), true).toString(16)}`
                                    : undefined;
                            // A nested pointer is expandable when it's non-null and we're above the
                            // depth ceiling. Its path extends the parent's so the open-set stays unique.
                            const childPath = () => `${props.path}/${offset().toString(16)}`;
                            const canExpand = () => !!target() && target() !== "0x0" && props.depth < MAX_DEPTH;

                            return (
                                <>
                                    <div class="ptr-expand-row">
                                        <span class="pe-disclosure">
                                            <Show when={canExpand()}>
                                                <button
                                                    class="node-disclosure"
                                                    title="expand pointer inline"
                                                    onClick={() => memory.toggleExpanded(childPath())}
                                                >
                                                    {memory.isExpanded(childPath()) ? "▾" : "▸"}
                                                </button>
                                            </Show>
                                        </span>
                                        <span class="col-offset">{offset().toString(16).toUpperCase().padStart(4, "0")}</span>
                                        <span class="col-address">{address().slice(2)}</span>
                                        <span class="col-hex">{inBounds() ? bytePairs(v(), offset(), size()) : ""}</span>
                                        <span class="col-type">{nodeType(node.typeId).label}</span>
                                        <span class="col-value">
                                            <Show when={value()} fallback={<span class="dim">-</span>}>
                                                {(val) => <span class="value-text">{val()}</span>}
                                            </Show>
                                        </span>
                                    </div>
                                    <Show when={canExpand() && memory.isExpanded(childPath())}>
                                        <PointerExpansion
                                            address={target() ?? "0x0"}
                                            path={childPath()}
                                            depth={props.depth + 1}
                                            paused={props.paused}
                                        />
                                    </Show>
                                </>
                            );
                        }}
                    </For>
                )}
            </Show>
        </div>
    );
}
