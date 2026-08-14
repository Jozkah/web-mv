import { For, Show, createSignal, type Accessor } from "solid-js";
import { useApp } from "../../app/AppContext";
import { dump, exports as fetchExports, imports as fetchImports, sections as fetchSections, peHeader as fetchPeHeader, peDirs as fetchPeDirs } from "../../protocol/requests";
import { errorText } from "../../state/errors";
import type { ExportEntry, ImportEntry, SectionEntry, PeHeaderResult, PeDirEntry } from "../../protocol/types";
import "./pe.css";

// PE / Symbols view: pick a module, then dump it or walk its section / export / import tables.
// This surfaces the ext agent's dump/exports/imports/sections verbs. Tables load on demand —
// exports/imports can be large, so nothing fetches until you click.

interface Loadable<T> {
    data: Accessor<T | undefined>;
    error: Accessor<string | undefined>;
    loading: Accessor<boolean>;
    run: () => void;
    clear: () => void;
}

function createLoadable<T>(fetcher: () => Promise<T>): Loadable<T> {
    const [data, setData] = createSignal<T>();
    const [error, setError] = createSignal<string>();
    const [loading, setLoading] = createSignal(false);
    let seq = 0;
    const run = async () => {
        const mine = ++seq;
        setLoading(true);
        setError(undefined);
        try {
            const r = await fetcher();
            if (mine === seq) setData(() => r);
        } catch (e) {
            if (mine === seq) setError(errorText(e));
        } finally {
            if (mine === seq) setLoading(false);
        }
    };
    const clear = () => {
        seq++;
        setData(undefined);
        setError(undefined);
        setLoading(false);
    };
    return { data, error, loading, run, clear };
}

export function PeView() {
    const { client, attached, modules, bookmarks } = useApp();
    const pin = (address: string, label: string) => bookmarks.add(address, label);
    const [selected, setSelected] = createSignal("");
    const [dumpMsg, setDumpMsg] = createSignal<string>();

    // `module: ""` tells the agent to use the main process module.
    const moduleArg = () => (selected() ? { module: selected() } : {});

    const header = createLoadable<PeHeaderResult>(async () => await fetchPeHeader(client, moduleArg()));
    const dirs = createLoadable<PeDirEntry[]>(async () => (await fetchPeDirs(client, moduleArg())).results);
    const sections = createLoadable<SectionEntry[]>(async () =>
        (await fetchSections(client, moduleArg())).results,
    );
    const exportsL = createLoadable<ExportEntry[]>(async () =>
        (await fetchExports(client, moduleArg())).results,
    );
    const importsL = createLoadable<ImportEntry[]>(async () =>
        (await fetchImports(client, moduleArg())).results,
    );

    const onModuleChange = (name: string) => {
        setSelected(name);
        setDumpMsg(undefined);
        header.clear();
        dirs.clear();
        sections.clear();
        exportsL.clear();
        importsL.clear();
    };

    const SUBSYSTEM: Record<number, string> = { 1: "Native", 2: "Windows GUI", 3: "Windows Console", 9: "Windows CE" };
    const MACHINE: Record<number, string> = { 0x8664: "x64", 0x14c: "x86", 0xaa64: "ARM64" };
    const fmtTime = (t: number) => (t > 0 ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");
    const dllFlags = (v: number): string => {
        const f: string[] = [];
        if (v & 0x0040) f.push("DYNAMIC_BASE");
        if (v & 0x0100) f.push("NX_COMPAT");
        if (v & 0x0400) f.push("NO_SEH");
        if (v & 0x1000) f.push("APPCONTAINER");
        if (v & 0x8000) f.push("TERMINAL_SERVER_AWARE");
        return f.length ? f.join(" · ") : "—";
    };

    const doDump = async () => {
        setDumpMsg("dumping…");
        try {
            const r = await dump(client, moduleArg());
            setDumpMsg(r.success ? `dumped → ${r.path}` : "dump failed");
        } catch (e) {
            setDumpMsg(errorText(e));
        }
    };

    return (
        <div class="pe-view">
            <div class="pe-toolbar">
                <select
                    class="pe-input"
                    value={selected()}
                    onChange={(ev) => onModuleChange(ev.currentTarget.value)}
                >
                    <option value="">(main module)</option>
                    <For each={modules.list()}>{(m) => <option value={m.name}>{m.name}</option>}</For>
                </select>
                <button class="pe-btn" onClick={() => modules.load()}>↻ modules</button>
                <button class="pe-btn" onClick={doDump} disabled={!attached()}>⬇ Dump</button>
                <Show when={dumpMsg()}><span class="pe-note">{dumpMsg()}</span></Show>
                <Show when={!attached()}><span class="pe-warn">agent not attached</span></Show>
            </div>

            <div class="pe-panels">
                <LoadPanel title="PE Header" loadable={header} onLoad={header.run} count={(h) => h.num_sections}>
                    {(h) => (
                        <div class="pe-header-grid">
                            <span class="k">Machine</span><span class="mono">{MACHINE[h.machine] ?? "0x" + h.machine.toString(16)}</span>
                            <span class="k">Magic</span><span class="mono">{h.magic === 0x20b ? "PE32+" : h.magic === 0x10b ? "PE32" : "0x" + h.magic.toString(16)}</span>
                            <span class="k">Entry point</span><span class="mono">{h.entry_point}</span>
                            <span class="k">Image base</span><span class="mono">{h.image_base}</span>
                            <span class="k">Size of image</span><span class="mono">0x{h.size_of_image.toString(16)}</span>
                            <span class="k">Sections</span><span class="mono">{h.num_sections}</span>
                            <span class="k">Timestamp</span><span class="mono">{fmtTime(h.timestamp)}</span>
                            <span class="k">Subsystem</span><span class="mono">{SUBSYSTEM[h.subsystem] ?? String(h.subsystem)}</span>
                            <span class="k">Checksum</span><span class="mono">0x{h.checksum.toString(16)}</span>
                            <span class="k">DLL flags</span><span class="mono">{dllFlags(h.dll_characteristics)}</span>
                        </div>
                    )}
                </LoadPanel>

                <LoadPanel title="Data Directories" loadable={dirs} onLoad={dirs.run} count={(d) => d.length}>
                    {(rows) => (
                        <table class="pe-table">
                            <thead><tr><th>Directory</th><th>Address</th><th>RVA</th><th>Size</th></tr></thead>
                            <tbody>
                                <For each={rows}>{(d) => (
                                    <tr>
                                        <td>{d.name}</td>
                                        <td class="mono">
                                            {d.address}
                                            <button class="pe-pin" title="Bookmark this directory" onClick={() => pin(d.address, d.name)}>🔖</button>
                                        </td>
                                        <td class="mono dim">{d.rva}</td>
                                        <td class="mono">0x{d.size.toString(16)}</td>
                                    </tr>
                                )}</For>
                            </tbody>
                        </table>
                    )}
                </LoadPanel>

                <LoadPanel title="Sections" loadable={sections} onLoad={sections.run} count={(d) => d.length}>
                    {(rows) => (
                        <table class="pe-table">
                            <thead><tr><th>Name</th><th>Address</th><th>Virtual size</th><th>Raw size</th><th>Prot</th></tr></thead>
                            <tbody>
                                <For each={rows}>{(sctn) => (
                                    <tr>
                                        <td class="mono">{sctn.name}</td>
                                        <td class="mono">
                                            {sctn.address}
                                            <button class="pe-pin" title="Bookmark this section" onClick={() => pin(sctn.address, sctn.name)}>🔖</button>
                                        </td>
                                        <td class="mono">0x{sctn.size.toString(16)}</td>
                                        <td class="mono">0x{sctn.raw_size.toString(16)}</td>
                                        <td class="mono prot">{sctn.protect}</td>
                                    </tr>
                                )}</For>
                            </tbody>
                        </table>
                    )}
                </LoadPanel>

                <LoadPanel title="Exports" loadable={exportsL} onLoad={exportsL.run} count={(d) => d.length}>
                    {(rows) => (
                        <table class="pe-table">
                            <thead><tr><th>Name</th><th>Address</th><th>Ord</th></tr></thead>
                            <tbody>
                                <For each={rows}>{(ex) => (
                                    <tr>
                                        <td class="mono">{ex.name}</td>
                                        <td class="mono">
                                            {ex.address}
                                            <button class="pe-pin" title="Bookmark this export" onClick={() => pin(ex.address, ex.name)}>🔖</button>
                                        </td>
                                        <td class="mono">{ex.ordinal}</td>
                                    </tr>
                                )}</For>
                            </tbody>
                        </table>
                    )}
                </LoadPanel>

                <LoadPanel title="Imports" loadable={importsL} onLoad={importsL.run} count={(d) => d.length}>
                    {(rows) => (
                        <table class="pe-table">
                            <thead><tr><th>From</th><th>Name</th><th>IAT slot</th></tr></thead>
                            <tbody>
                                <For each={rows}>{(im) => (
                                    <tr>
                                        <td class="mono dim">{im.module}</td>
                                        <td class="mono">{im.name}</td>
                                        <td class="mono">
                                            {im.iat}
                                            <button class="pe-pin" title="Bookmark this IAT slot" onClick={() => pin(im.iat, im.name)}>🔖</button>
                                        </td>
                                    </tr>
                                )}</For>
                            </tbody>
                        </table>
                    )}
                </LoadPanel>
            </div>
        </div>
    );
}

function LoadPanel<T>(props: {
    title: string;
    loadable: Loadable<T>;
    onLoad: () => void;
    count: (d: T) => number;
    children: (data: T) => unknown;
}) {
    return (
        <section class="pe-panel">
            <header class="pe-panel-head">
                <span class="pe-panel-title">{props.title}</span>
                <Show when={props.loadable.data()}>
                    {(d) => <span class="pe-panel-count">{props.count(d())}</span>}
                </Show>
                <button class="pe-btn small" onClick={props.onLoad} disabled={props.loadable.loading()}>
                    {props.loadable.loading() ? "…" : "Load"}
                </button>
            </header>
            <Show when={props.loadable.error()}>
                <div class="pe-warn">{props.loadable.error()}</div>
            </Show>
            <Show when={props.loadable.data()}>
                {(d) => <div class="pe-panel-body">{props.children(d()) as any}</div>}
            </Show>
        </section>
    );
}
