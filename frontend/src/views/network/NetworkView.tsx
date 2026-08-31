import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { validateTsharkConfig } from "../../state/tsharkConfig";
import type { TsharkSidecarState } from "../../state/networkStore";
import { hexDump, type TreeNode } from "../../network/pcapParse";
import { createListVirtualizer } from "../../ui/virtualList";
import { ResizeHandle } from "../../ui/ResizeHandle";
import { usePersistedWidth } from "../../ui/resize";
import "./network.css";

// Offline PCAP analysis via the optional tshark sidecar. It NEVER captures live packets and the packets
// are NOT correlated to the attached Angel target (a capture carries no PID/socket ownership). Display
// filters run offline against the imported file; capture filters (live) and process correlation stay
// unavailable by construction.

const STATE_LABEL: Record<TsharkSidecarState, { text: string; tone: string }> = {
    unconfigured: { text: "unconfigured", tone: "off" },
    pathValid: { text: "path valid", tone: "warn" },
    runnable: { text: "runnable (unvalidated)", tone: "warn" },
    readyUnvalidated: { text: "ready (unvalidated)", tone: "warn" },
    liveValidated: { text: "validated", tone: "ok" },
    failed: { text: "failed", tone: "danger" },
    timedOut: { text: "timed out", tone: "danger" },
};

type LowerTab = "packet" | "conversations" | "endpoints" | "follow";

function TreeView(props: { nodes: TreeNode[] }) {
    return (
        <For each={props.nodes}>
            {(n) => (
                <div class="nw-tnode">
                    <span class="nw-tkey">{n.name}</span>
                    <Show when={n.value !== undefined}>: <span class="nw-tval">{n.value}</span></Show>
                    <Show when={n.children.length > 0}>
                        <TreeView nodes={n.children} />
                    </Show>
                </div>
            )}
        </For>
    );
}

export function NetworkView() {
    const app = useApp();
    const n = app.network;
    const cfg = () => app.tshark.config();
    const status = () => app.capabilities.get("network.pcapImport");
    const liveStatus = () => app.capabilities.get("network.liveCapture");
    const corrStatus = () => app.capabilities.get("network.processCorrelation");
    const errors = createMemo(() => validateTsharkConfig(cfg()));

    const [pcapName, setPcapName] = createSignal("");
    const [filter, setFilter] = createSignal("");
    const [selected, setSelected] = createSignal<number>(); // frame number
    const [lowerTab, setLowerTab] = createSignal<LowerTab>("packet");
    const [relinkName, setRelinkName] = createSignal("");
    const [relinkMismatch, setRelinkMismatch] = createSignal(false);
    const [annDraft, setAnnDraft] = createSignal("");

    const doRelink = async (force: boolean) => {
        const f = relinkName().trim();
        if (!f) return;
        const r = await n.relinkCapture(f, { force });
        setRelinkMismatch(r.mismatch === true);
    };

    const st = () => STATE_LABEL[n.sidecarState()];
    const dissection = createMemo(() => (selected() !== undefined ? n.cachedDissection(selected()!) : undefined));
    const selectedPkt = createMemo(() => n.packets().find((p) => p.number === selected()));

    const doImport = () => { const f = pcapName().trim(); if (f) { setSelected(undefined); n.importPcap(f); } };
    const selectRow = (frame: number) => { setSelected(frame); setLowerTab("packet"); n.dissectPacket(frame); };
    const followSelected = () => {
        const p = selectedPkt();
        if (!p) return;
        if (p.tcpStream !== undefined) { n.followStream("tcp", p.tcpStream); setLowerTab("follow"); }
        else if (p.udpStream !== undefined) { n.followStream("udp", p.udpStream); setLowerTab("follow"); }
    };
    const exportPacket = () => {
        const p = selectedPkt();
        if (p) navigator.clipboard?.writeText(JSON.stringify(p, null, 2));
    };
    const exportFollow = () => {
        const f = n.follow();
        if (!f) return;
        if (!confirm("Copy the followed stream (decoded bytes) to the clipboard? It leaves this tool via the clipboard.")) return;
        const text = f.chunks.map((c) => `[node ${c.fromNode}] ${c.hex}`).join("\n");
        navigator.clipboard?.writeText(text);
    };

    const { setRef, virtualizer } = createListVirtualizer(() => n.packets().length, 20);
    const bytesW = usePersistedWidth("network.bytes", 360, 220, 960); // resizable raw-bytes pane

    return (
        <div class="nw-view">
            <div class="nw-config">
                <div class="nw-section">tshark (local, user-supplied — nothing downloaded). OFFLINE analysis only — not live capture, not tied to the attached target.</div>
                <div class="nw-grid">
                    <label>Enabled</label>
                    <input type="checkbox" checked={cfg().enabled} onChange={(e) => app.tshark.update({ enabled: e.currentTarget.checked })} />
                    <label>tshark path</label>
                    <input value={cfg().tsharkPath} placeholder="C:\\Program Files\\Wireshark\\tshark.exe" onChange={(e) => app.tshark.update({ tsharkPath: e.currentTarget.value })} />
                    <label>PCAP directory</label>
                    <input value={cfg().pcapDirectory ?? ""} placeholder="folder holding your .pcap / .pcapng files" onChange={(e) => app.tshark.update({ pcapDirectory: e.currentTarget.value })} />
                    <label>Max packets</label>
                    <input type="number" value={cfg().maxPackets} onChange={(e) => app.tshark.update({ maxPackets: Number(e.currentTarget.value) })} />
                </div>
                <div class="nw-meta">
                    <span class={`nw-pill ${st().tone}`}>{st().text}</span>
                    <span>{status().provenance} · {status().level}{n.version() ? ` · tshark ${n.version()}` : ""}</span>
                    <span title="live capture is a separate, more privileged capability">live capture: <b>unavailable</b> ({liveStatus().missingPrimitive})</span>
                    <span title="a pcap carries no process identity">packet↔process: <b>unavailable</b> ({corrStatus().missingPrimitive})</span>
                    <Show when={errors().length > 0}><span class="nw-reason">{errors().join("; ")}</span></Show>
                    <Show when={n.lastError()}><span class="nw-reason">{n.lastError()}</span></Show>
                </div>
            </div>

            <div class="nw-toolbar">
                <input placeholder="capture filename (in the PCAP directory)" value={pcapName()} onInput={(e) => setPcapName(e.currentTarget.value)} disabled={!status().available} style={{ "min-width": "220px" }} />
                <button class="nw-btn primary" disabled={!status().available || n.busy()} onClick={doImport}>{n.busy() ? "importing…" : "Import PCAP"}</button>
                <input class="nw-filter" placeholder="display filter e.g. tcp.port==443 (offline)" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} disabled={!status().available || !n.activePcap()}
                    onKeyDown={(e) => { if (e.key === "Enter") n.applyFilter(filter()); }} />
                <button class="nw-btn" disabled={!status().available || !n.activePcap() || n.busy()} onClick={() => n.applyFilter(filter())}>Apply filter</button>
                <Show when={n.activeFilter()}><button class="nw-btn" onClick={() => { setFilter(""); n.clearFilter(); }}>Clear</button></Show>
                <For each={n.savedFiltersList()}>
                    {(f) => <button class="nw-btn" title="saved filter — click to apply" onClick={() => { setFilter(f); n.applyFilter(f); }}>{f}</button>}
                </For>
            </div>

            <Show when={!status().available}>
                <div class="nw-warn">Configure a local tshark path and PCAP directory above. Angel provides no packet dissection, so tshark supplies it; these packets are never attributed to the attached process. {status().reason}</div>
            </Show>

            <Show when={n.imported()}>
                {(imp) => (
                    <div class="nw-warn">
                        <b>Imported capture — source PCAP unavailable.</b> {imp().packetCount} packets · {imp().protocols.slice(0, 6).join(", ")} · hash {imp().captureHash.slice(0, 12)}…
                        Annotations and bookmarks are shown from the bundle. To analyze, <b>Relink</b> the original file (its hash is verified):
                        <input placeholder={imp().filename ?? "capture filename"} value={relinkName()} onInput={(e) => setRelinkName(e.currentTarget.value)} style={{ "margin-left": "6px" }} />
                        <button class="nw-btn" disabled={!status().available} onClick={() => doRelink(false)}>Relink</button>
                        <Show when={relinkMismatch()}>
                            <span class="nw-reason"> hash mismatch — not the imported capture. </span>
                            <button class="nw-btn" onClick={() => doRelink(true)}>Relink anyway (force)</button>
                        </Show>
                    </div>
                )}
            </Show>

            <Show when={n.metadata()}>
                {(m) => (
                    <div class="nw-meta">
                        <span>{m().packetCount} packets{m().truncated ? " (truncated)" : ""}</span>
                        <Show when={m().durationSec !== undefined}><span>{m().durationSec!.toFixed(3)}s span</span></Show>
                        <Show when={m().captureBytes}><span>{(m().captureBytes! / 1024).toFixed(0)} KiB</span></Show>
                        <span>protocols: {m().protocols.slice(0, 8).join(", ") || "—"}</span>
                        <Show when={n.activeFilter()}><span>filter: <code>{n.activeFilter()}</code></span></Show>
                    </div>
                )}
            </Show>

            <div class="nw-body">
                <div class="nw-head-row nw-row"><span>No.</span><span>Time</span><span>Source</span><span>Destination</span><span>Proto</span><span>Info</span></div>
                <div class="nw-list" ref={setRef}>
                    <Show when={n.packets().length > 0} fallback={<div class="nw-empty small">{status().available ? "Import a capture to list packets." : "tshark not configured."}</div>}>
                        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
                            <For each={virtualizer.getVirtualItems()}>
                                {(vi) => {
                                    const p = () => n.packets()[vi.index]!;
                                    return (
                                        <div class="nw-row" classList={{ sel: selected() === p().number }} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: `${vi.size}px`, transform: `translateY(${vi.start}px)` }} onClick={() => selectRow(p().number)}>
                                            <span class="num">{p().number}</span>
                                            <span>{p().timeEpoch?.toFixed(3) ?? ""}</span>
                                            <span>{p().src ?? ""}{p().srcPort !== undefined ? `:${p().srcPort}` : ""}</span>
                                            <span>{p().dst ?? ""}{p().dstPort !== undefined ? `:${p().dstPort}` : ""}</span>
                                            <span>{p().protocol ?? ""}</span>
                                            <span class="info">{p().info ?? p().dns ?? p().tlsSni ?? ""}</span>
                                        </div>
                                    );
                                }}
                            </For>
                        </div>
                    </Show>
                </div>

                <div class="nw-tabs">
                    <For each={["packet", "conversations", "endpoints", "follow"] as LowerTab[]}>
                        {(t) => <div class="nw-tab" classList={{ active: lowerTab() === t }} onClick={() => setLowerTab(t)}>{t}</div>}
                    </For>
                    <Show when={selectedPkt() && (selectedPkt()!.tcpStream !== undefined || selectedPkt()!.udpStream !== undefined)}>
                        <button class="nw-btn" style={{ "margin-left": "8px" }} onClick={followSelected}>Follow stream</button>
                    </Show>
                    <Show when={selectedPkt()}><button class="nw-btn" onClick={exportPacket}>Copy packet</button></Show>
                </div>

                <Show when={lowerTab() === "packet"}>
                    <Show when={selected() !== undefined}>
                        <div class="nw-meta">
                            <button class="nw-btn" onClick={() => n.toggleBookmark(selected()!)}>{n.isBookmarked(selected()!) ? "★ bookmarked" : "☆ bookmark"}</button>
                            <input placeholder="annotate this packet…" value={annDraft()} onInput={(e) => setAnnDraft(e.currentTarget.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") { n.annotate(selected()!, annDraft()); setAnnDraft(""); } }} style={{ "min-width": "220px" }} />
                            <button class="nw-btn" onClick={() => { n.annotate(selected()!, annDraft()); setAnnDraft(""); }}>Save note</button>
                            <Show when={n.annotationOf(selected()!)}>{(note) => <span>note: {note()}</span>}</Show>
                            <Show when={n.activeFilter()}><button class="nw-btn" onClick={() => n.saveFilter(n.activeFilter()!)}>Save filter</button></Show>
                        </div>
                    </Show>
                    <div class="nw-split">
                        <div class="nw-tree">
                            <Show when={dissection()} fallback={<div class="nw-empty small">{selected() !== undefined ? "Dissecting…" : "Select a packet."}</div>}>
                                {(d) => (
                                    <>
                                        <Show when={d().truncatedTree}><div class="nw-reason">protocol tree truncated</div></Show>
                                        <TreeView nodes={d().tree} />
                                    </>
                                )}
                            </Show>
                        </div>
                        <ResizeHandle value={bytesW.width()} min={bytesW.min} max={bytesW.max} onSet={bytesW.set} onReset={bytesW.reset} label="Resize raw-bytes pane" />
                        <div class="nw-bytes" style={{ width: `${bytesW.width()}px`, flex: "0 0 auto" }}>
                            <Show when={dissection()?.rawHex} fallback={<div class="nw-empty small">Raw bytes appear for the selected packet.</div>}>
                                {(hex) => <>{hexDump(hex()).join("\n")}</>}
                            </Show>
                        </div>
                    </div>
                </Show>

                <Show when={lowerTab() === "conversations"}>
                    <div class="nw-panel">
                        <div class="nw-tblrow head"><span>A</span><span>B</span><span>Proto</span><span>Packets</span><span>Bytes</span></div>
                        <For each={n.conversations()}>{(c) => <div class="nw-tblrow"><span>{c.a}</span><span>{c.b}</span><span>{c.protocol}{c.stream !== undefined ? ` #${c.stream}` : ""}</span><span>{c.packets}</span><span>{c.bytes}</span></div>}</For>
                    </div>
                </Show>

                <Show when={lowerTab() === "endpoints"}>
                    <div class="nw-panel">
                        <div class="nw-tblrow head"><span>Address</span><span /><span /><span>Packets</span><span>Bytes</span></div>
                        <For each={n.endpoints()}>{(e) => <div class="nw-tblrow"><span>{e.address}</span><span /><span /><span>{e.packets}</span><span>{e.bytes}</span></div>}</For>
                    </div>
                </Show>

                <Show when={lowerTab() === "follow"}>
                    <div class="nw-panel">
                        <Show when={n.follow()} fallback={<div class="nw-empty small">Select a TCP/UDP packet and click “Follow stream”.</div>}>
                            {(f) => (
                                <>
                                    <div class="nw-meta">
                                        <span>node 0: {f().node0 ?? "?"}</span><span>node 1: {f().node1 ?? "?"}</span>
                                        <span>{f().totalBytes} bytes{f().truncated ? " (truncated)" : ""}</span>
                                        <button class="nw-btn" onClick={exportFollow}>Export stream…</button>
                                    </div>
                                    <For each={f().chunks}>{(c) => <div class={`nw-chunk n${c.fromNode}`}>{c.hex}</div>}</For>
                                </>
                            )}
                        </Show>
                    </div>
                </Show>
            </div>
        </div>
    );
}
