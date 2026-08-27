import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../../../app/AppContext";
import { useStatic } from "../state/StaticContext";
import { parseHex, rvaOf } from "../../../state/address";
import { sigScanIda } from "../../../protocol/requests";
import { errorText } from "../../../state/errors";
import { Panel } from "../../../ui/Panel";
import { RenameInput } from "../../../ui/RenameInput";
import { StatusOverlay } from "../../../ui/StatusOverlay";
import { createListVirtualizer } from "../../../ui/virtualList";
import { resolveFunctionHits, type FunctionSigHit } from "../../../scan/functionSigSearch";

const ROW_HEIGHT = 28;

// Exact text measurement so column lanes fit their content to the pixel - `ch` units only
// approximate the real advance and leave the text a hair too wide, tripping the ellipsis.
const ROW_FONT = '13px ui-monospace, Consolas, "Courier New", monospace';
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(s: string): number {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    if (!measureCtx) return s.length * 8; // canvas unavailable (SSR/old): rough fallback
    measureCtx.font = ROW_FONT;
    return measureCtx.measureText(s).width;
}

type SortKey = "address" | "size";
type SearchMode = "text" | "sig";

// Middle panel: functions for the selected module, served from the cache (instant on
// re-select). Pinned functions float to the top; double-click a name to rename; the star
// toggles a pin; the sort bar orders by address, size, or scan type.
//
// Supports both standard substring/address searching and IDA-style Signature Search (sigsearch)
// to locate containing functions matching a byte pattern or function prologue.

export function FunctionList(props: { width?: number }) {
    const { client, attached, modules, annotations } = useApp();
    const { functions, selection, selectFunction } = useStatic();

    const moduleName = () => selection.selectedModule();
    const entry = () => {
        const m = moduleName();
        return m ? functions.get(m) : undefined;
    };
    const errorMsg = () => {
        const e = entry();
        return e?.status === "error" ? e.error : undefined;
    };

    const [sortKey, setSortKey] = createSignal<SortKey>("address");
    const [sortAsc, setSortAsc] = createSignal(true);
    const toggleSort = (key: SortKey) => {
        if (sortKey() === key) setSortAsc((asc) => !asc);
        else {
            setSortKey(key);
            setSortAsc(true);
        }
    };
    const sortArrow = (key: SortKey) => (sortKey() !== key ? "" : sortAsc() ? "▲" : "▼");

    // Search state
    const [searchMode, setSearchMode] = createSignal<SearchMode>("text");
    const [query, setQuery] = createSignal("");

    // Function Sigsearch state
    const [sigPattern, setSigPattern] = createSignal("");
    const [sigPrologueOnly, setSigPrologueOnly] = createSignal(false);
    const [sigStatus, setSigStatus] = createSignal<"idle" | "scanning" | "done" | "error">("idle");
    const [sigMap, setSigMap] = createSignal<Map<string, FunctionSigHit>>(new Map());
    const [sigError, setSigError] = createSignal<string | null>(null);

    const runSigScan = async () => {
        const m = moduleName();
        if (!m || !sigPattern().trim() || !attached()) return;

        setSigStatus("scanning");
        setSigError(null);
        try {
            const raw = await sigScanIda(client, {
                pattern: sigPattern().trim(),
                module: m,
                find_all: true,
            });

            const base = modules.baseOf(m);
            const e = functions.get(m);
            const fns = e?.status === "ready" ? e.data : [];

            if (base && fns.length > 0) {
                const resolved = resolveFunctionHits(raw.results, m, base, fns, annotations);
                const map = new Map<string, FunctionSigHit>();
                for (const h of resolved) {
                    if (h.function) {
                        const existing = map.get(h.function.address);
                        // If multiple hits land in the same function, prioritize prologue (+0x0) or first hit
                        if (!existing || h.isPrologue) {
                            map.set(h.function.address, h);
                        }
                    }
                }
                setSigMap(map);
            } else {
                setSigMap(new Map());
            }
            setSigStatus("done");
        } catch (err) {
            setSigStatus("error");
            setSigError(errorText(err));
        }
    };

    const clearSigScan = () => {
        setSigPattern("");
        setSigStatus("idle");
        setSigMap(new Map());
        setSigError(null);
    };

    // Function rows: enriched with RVA, filtered by the search query / sigsearch, sorted by the chosen
    // key, pinned ones floated to the top.
    const rows = createMemo(() => {
        const m = moduleName();
        const e = m ? functions.get(m) : undefined;
        if (!m || e?.status !== "ready") return [];
        const base = modules.baseOf(m);
        if (!base) return [];

        const byAddress = (a: string, b: string) => {
            const x = parseHex(a);
            const y = parseHex(b);
            return x < y ? -1 : x > y ? 1 : 0;
        };
        const mapped = e.data.map((f) => ({
            address: f.address,
            size: f.size,
            rva: rvaOf(base, f.address),
        }));

        let filtered = mapped;

        if (searchMode() === "text") {
            const q = query().trim().toLowerCase();
            filtered = q
                ? mapped.filter(
                      (f) =>
                          f.address.toLowerCase().includes(q) ||
                          annotations.nameOf(m, f.rva).toLowerCase().includes(q),
                  )
                : mapped;
        } else if (searchMode() === "sig" && sigStatus() === "done") {
            const map = sigMap();
            const prologueOnly = sigPrologueOnly();
            filtered = mapped.filter((f) => {
                const hit = map.get(f.address);
                if (!hit) return false;
                if (prologueOnly) return hit.isPrologue;
                return true;
            });
        }

        const key = sortKey();
        const dir = sortAsc() ? 1 : -1;
        filtered.sort((a, b) => {
            const primary = key === "size" ? a.size - b.size : byAddress(a.address, b.address);
            return (primary || byAddress(a.address, b.address)) * dir;
        });

        const pinnedRvas = new Set(
            annotations.pinned().filter((a) => a.module === m).map((a) => a.rva),
        );
        return [
            ...filtered.filter((f) => pinnedRvas.has(f.rva)),
            ...filtered.filter((f) => !pinnedRvas.has(f.rva)),
        ];
    });

    // Widest rendered text per column. The row font is monospace, so character count is
    // proportional to pixel width - which lets us find the widest cell by string length (cheap)
    // and run the expensive canvas measureText() only three times, once per column, instead of
    // 3x per function. On a 100k+ function module that is the difference between an instant open
    // and a multi-second hang (359k canvas measurements).
    const NAME_MAX = 360;
    const columns = createMemo(() => {
        const m = moduleName();
        const e = m ? functions.get(m) : undefined;
        const base = m ? modules.baseOf(m) : undefined;
        if (!m || e?.status !== "ready" || !base) return undefined;

        let nameStr = "";
        let addrStr = "";
        let sizeStr = "";
        for (const f of e.data) {
            const nm = annotations.nameOf(m, rvaOf(base, f.address));
            if (nm.length > nameStr.length) nameStr = nm;
            if (f.address.length > addrStr.length) addrStr = f.address;
            const sz = `${f.size}B`;
            if (sz.length > sizeStr.length) sizeStr = sz;
        }
        return {
            name: Math.min(Math.ceil(textWidth(nameStr)), NAME_MAX),
            addr: Math.ceil(textWidth(addrStr)),
            size: Math.ceil(textWidth(sizeStr)),
        };
    });

    const PAD = 26;
    const PIN = 32;
    const lane = (px: number, border = 0) => `${px + PAD + border}px`;
    const gridTemplate = createMemo(() => {
        const c = columns();
        return c
            ? `auto ${lane(c.name)} ${lane(c.addr, 1)} ${lane(c.size, 1)} minmax(0, 1fr)`
            : undefined;
    });

    const contentWidth = createMemo(() => {
        const c = columns();
        if (!c) return undefined;
        const total = c.name + c.addr + c.size + PAD * 3 + 2 + PIN;
        return `${total}px`;
    });

    const { setRef, virtualizer } = createListVirtualizer(() => rows().length, ROW_HEIGHT);

    const [editing, setEditing] = createSignal<string | null>(null);
    const commitRename = (module: string, rva: string, value: string) => {
        annotations.rename(module, rva, value);
        setEditing(null);
    };

    return (
        <>
            <Panel
                class="panel-functions"
                style={
                    // A user-dragged width (props.width) wins over the content-derived width, so the
                    // pane holds where the divider left it. Falls back to auto-sizing until dragged.
                    props.width !== undefined
                        ? { flex: "0 0 auto", width: `${props.width}px` }
                        : contentWidth()
                          ? { flex: "0 0 auto", width: contentWidth() }
                          : undefined
                }
                title="functions"
                meta={
                    <Show when={moduleName()} fallback="none">
                        {(m) => (
                            <>
                                {m()}
                                <Show when={entry()?.status === "ready"}> · {rows().length}</Show>
                            </>
                        )}
                    </Show>
                }
                actions={
                    <div style={{ display: "flex", gap: "4px" }}>
                        <button
                            onClick={() => {
                                const m = moduleName();
                                if (m) functions.refresh(m);
                            }}
                            disabled={moduleName() === null || entry()?.status === "loading"}
                        >
                            refresh
                        </button>
                    </div>
                }
            >
                <div class="sortbar">
                    <span class="sortbar-label">sort</span>
                    <button classList={{ active: sortKey() === "address" }} onClick={() => toggleSort("address")}>
                        addr {sortArrow("address")}
                    </button>
                    <button classList={{ active: sortKey() === "size" }} onClick={() => toggleSort("size")}>
                        size {sortArrow("size")}
                    </button>

                    <span class="sortbar-sep" />

                    <div class="search-mode-tabs">
                        <button
                            classList={{ active: searchMode() === "text" }}
                            onClick={() => setSearchMode("text")}
                        >
                            name/addr
                        </button>
                        <button
                            classList={{ active: searchMode() === "sig" }}
                            onClick={() => setSearchMode("sig")}
                            title="Find functions matching an IDA signature pattern"
                        >
                            sigsearch
                        </button>
                    </div>
                </div>

                <Show
                    when={searchMode() === "sig"}
                    fallback={
                        <div class="searchbar">
                            <input
                                class="search"
                                type="text"
                                placeholder="search name or address"
                                value={query()}
                                onInput={(e) => setQuery(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Escape") setQuery("");
                                }}
                            />
                        </div>
                    }
                >
                    <div class="sigsearch-bar">
                        <div class="sigsearch-input-row">
                            <input
                                class="search sig-input"
                                type="text"
                                placeholder="IDA pattern, e.g. 48 89 5C 24 ??"
                                value={sigPattern()}
                                onInput={(e) => setSigPattern(e.currentTarget.value)}
                                onKeyDown={(e) => e.key === "Enter" && runSigScan()}
                            />
                            <button
                                class="sig-scan-btn"
                                onClick={runSigScan}
                                disabled={!attached() || !moduleName() || !sigPattern().trim() || sigStatus() === "scanning"}
                            >
                                {sigStatus() === "scanning" ? "scanning…" : "scan sig"}
                            </button>
                        </div>

                        <div class="sigsearch-opts-row">
                            <label class="sig-field check">
                                <input
                                    type="checkbox"
                                    checked={sigPrologueOnly()}
                                    onChange={(e) => setSigPrologueOnly(e.currentTarget.checked)}
                                />
                                prologues only (+0x0)
                            </label>

                            <Show when={sigStatus() === "done"}>
                                <span class="sig-stats">
                                    {sigMap().size} functions matched
                                </span>
                                <button class="sig-clear-btn" onClick={clearSigScan}>
                                    clear
                                </button>
                            </Show>
                        </div>

                        <Show when={sigError()}>
                            {(err) => <div class="sig-error">{err()}</div>}
                        </Show>
                    </div>
                </Show>

                <div class="panel-body">
                    <div ref={setRef} class="list" style={{ "--fn-cols": gridTemplate() ?? "" }}>
                        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
                            <For each={virtualizer.getVirtualItems()}>
                                {(item) => {
                                    const m = moduleName();
                                    const fn = () => rows()[item.index];
                                    const rva = () => fn()?.rva ?? "";
                                    const pinned = () => (m && rva() ? annotations.isPinned(m, rva()) : false);
                                    const selected = () => {
                                        const sel = selection.selectedFunction();
                                        const current = fn();
                                        return !!(sel && m && current && sel.module === m && sel.address === current.address);
                                    };
                                    const sigHit = () => {
                                        const current = fn();
                                        return current ? sigMap().get(current.address) : undefined;
                                    };

                                    return (
                                        <Show when={fn() && m}>
                                            <div
                                                class="row fn-row"
                                                classList={{ selected: selected() }}
                                                style={{
                                                    position: "absolute",
                                                    top: 0,
                                                    left: 0,
                                                    width: "100%",
                                                    height: `${item.size}px`,
                                                    transform: `translateY(${item.start}px)`,
                                                }}
                                                onClick={() => {
                                                    const current = fn();
                                                    if (m && current) selectFunction(m, current);
                                                }}
                                            >
                                                <button
                                                    class="pin"
                                                    classList={{ active: pinned() }}
                                                    title={pinned() ? "unpin" : "pin"}
                                                    onClick={(ev) => {
                                                        ev.stopPropagation();
                                                        const current = fn();
                                                        if (m && current) annotations.togglePin(m, current.rva);
                                                    }}
                                                >
                                                    {pinned() ? "★" : "☆"}
                                                </button>
                                                <Show
                                                    when={editing() === rva()}
                                                    fallback={
                                                        <span
                                                            class="grow fn-name"
                                                            title="double-click to rename"
                                                            classList={{ custom: annotations.hasCustomName(m!, rva()) }}
                                                            onDblClick={(ev) => {
                                                                ev.stopPropagation();
                                                                if (rva()) setEditing(rva());
                                                            }}
                                                        >
                                                            {annotations.nameOf(m!, rva())}
                                                            <Show when={searchMode() === "sig" && sigHit()}>
                                                                {(hit) => (
                                                                    <span
                                                                        class="fn-sig-tag"
                                                                        classList={{ prologue: hit().isPrologue }}
                                                                    >
                                                                        {hit().isPrologue ? "PROLOGUE" : `+0x${hit().offset?.toString(16)}`}
                                                                    </span>
                                                                )}
                                                            </Show>
                                                        </span>
                                                    }
                                                >
                                                    <RenameInput
                                                        class="grow rename"
                                                        value={annotations.nameOf(m!, rva())}
                                                        onCommit={(value) => commitRename(m!, rva(), value)}
                                                        onCancel={() => setEditing(null)}
                                                    />
                                                </Show>
                                                <span class="addr">{fn()?.address}</span>
                                                <span class="dim">{fn()?.size}B</span>
                                            </div>
                                        </Show>
                                    );
                                }}
                            </For>
                        </div>
                    </div>

                    <StatusOverlay message={moduleName() === null && "select a module to view its functions"} />
                    <StatusOverlay
                        message={moduleName() !== null && entry()?.status === "loading" && "enumerating…"}
                    />
                    <StatusOverlay message={errorMsg()} error />
                </div>
            </Panel>
        </>
    );
}


