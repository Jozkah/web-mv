import { For, Show, createMemo } from "solid-js";
import { useApp } from "../../app/AppContext";
import { useStrings } from "./state/StringsContext";
import { useMemory } from "../memory/state/MemoryContext";
import { StatusOverlay } from "../../ui/StatusOverlay";
import { ModulePicker } from "../../scan/ModulePicker";
import { createListVirtualizer } from "../../ui/virtualList";
import type { SortColumn } from "./state/StringsContext";

// The IDA-style Strings view: select a module, scan its memory for all readable strings,
// and present them in a sortable, filterable, virtualized table. Each string shows its
// address, character count, encoding type, and value. Click an address to create a memory
// class at that location.

const ROW_HEIGHT = 28;

export function StringsView() {
    const app = useApp();
    const strings = useStrings();
    const memory = useMemory();

    const canScan = () =>
        app.attached() && strings.selectedModule() !== "" && strings.status() !== "scanning";

    const doScan = () => {
        const modName = strings.selectedModule();
        const mod = app.modules.list().find((m) => m.name === modName);
        if (!mod) return;
        strings.scan(modName, mod.base, mod.size);
    };

    const createClass = (address: string) => {
        memory.addClassAt(address);
        app.setActiveView("memory");
    };

    const count = createMemo(() => strings.filteredStrings().length);
    const { setRef, virtualizer } = createListVirtualizer(count, ROW_HEIGHT);

    const sortIndicator = (col: SortColumn) => {
        if (strings.sortColumn() !== col) return "";
        return strings.sortDir() === "asc" ? " ▴" : " ▾";
    };

    const overlayMessage = (): string | false => {
        const s = strings.status();
        if (s === "idle" && strings.allStrings().length === 0) return "select a module and scan to enumerate strings";
        if (s === "error") return strings.error();
        if (s === "ready" && strings.allStrings().length === 0) return "no strings found";
        return false;
    };

    const progressPercent = () => Math.round(strings.progress().fraction * 100);

    return (
        <div class="strings-view">
            <section class="strings-panel panel">
                <header class="panel-head">
                    <h2>Strings</h2>
                    <span class="meta">
                        <Show when={strings.status() === "ready"}>
                            {strings.allStrings().length.toLocaleString()} strings
                            <Show when={strings.filteredStrings().length !== strings.allStrings().length}>
                                {" "}· {strings.filteredStrings().length.toLocaleString()} shown
                            </Show>
                        </Show>
                        <Show when={strings.status() === "scanning"}>
                            scanning… {progressPercent()}% · {strings.progress().found.toLocaleString()} found
                        </Show>
                    </span>
                    <Show
                        when={strings.status() !== "scanning"}
                        fallback={
                            <button onClick={() => strings.cancel()}>cancel</button>
                        }
                    >
                        <button onClick={doScan} disabled={!canScan()}>
                            scan
                        </button>
                    </Show>
                </header>

                {/* Controls bar */}
                <div class="strings-controls">
                    <div class="strings-controls-row">
                        <label class="strings-field">
                            <ModulePicker
                                value={strings.selectedModule()}
                                onChange={(name) => {
                                    const mod = app.modules.list().find((m) => m.name === name);
                                    if (mod) strings.scan(name, mod.base, mod.size);
                                }}
                            />
                        </label>
                        <label class="strings-field" title="minimum character length to qualify as a string">
                            min length
                            <input
                                class="strings-num"
                                type="number"
                                min="2"
                                max="100"
                                value={strings.minLength()}
                                onInput={(e) =>
                                    strings.setMinLength(
                                        Math.max(2, e.currentTarget.valueAsNumber || 4),
                                    )
                                }
                            />
                        </label>
                        <label class="strings-field">
                            <select
                                class="strings-select"
                                value={strings.encodingFilter()}
                                onChange={(e) =>
                                    strings.setEncodingFilter(
                                        e.currentTarget.value as "all" | "ascii" | "utf16",
                                    )
                                }
                            >
                                <option value="all">All encodings</option>
                                <option value="ascii">ASCII</option>
                                <option value="utf16">UTF-16</option>
                            </select>
                        </label>

                        {/* Category filter pills */}
                        <div class="strings-pills">
                            <button
                                class="strings-pill"
                                classList={{ active: strings.categoryFilter() === "all" }}
                                onClick={() => strings.setCategoryFilter("all")}
                            >
                                All
                            </button>
                            <button
                                class="strings-pill"
                                classList={{ active: strings.categoryFilter() === "url" }}
                                onClick={() => strings.setCategoryFilter("url")}
                            >
                                🌐 URLs
                            </button>
                            <button
                                class="strings-pill"
                                classList={{ active: strings.categoryFilter() === "path" }}
                                onClick={() => strings.setCategoryFilter("path")}
                            >
                                📁 Paths
                            </button>
                            <button
                                class="strings-pill"
                                classList={{ active: strings.categoryFilter() === "cmd" }}
                                onClick={() => strings.setCategoryFilter("cmd")}
                            >
                                💬 Cmds
                            </button>
                            <button
                                class="strings-pill"
                                classList={{ active: strings.categoryFilter() === "rtti" }}
                                onClick={() => strings.setCategoryFilter("rtti")}
                            >
                                🏷️ RTTI
                            </button>
                        </div>

                        {/* Export actions */}
                        <div class="strings-export-group" style={{ "margin-left": "auto" }}>
                            <button class="strings-export-btn" title="export to CSV" onClick={() => strings.exportCsv()}>
                                CSV
                            </button>
                            <button class="strings-export-btn" title="export to JSON" onClick={() => strings.exportJson()}>
                                JSON
                            </button>
                            <button class="strings-export-btn" title="export to plain text" onClick={() => strings.exportTxt()}>
                                TXT
                            </button>
                        </div>
                    </div>

                    <div class="strings-search-bar">
                        <input
                            class="strings-search"
                            type="text"
                            placeholder={strings.useRegex() ? "regex filter (e.g. ^cmd_)..." : "filter strings..."}
                            value={strings.filter()}
                            onInput={(e) => strings.setFilter(e.currentTarget.value)}
                        />
                        <label class="strings-field check" title="enable Regular Expression matching">
                            <input
                                type="checkbox"
                                checked={strings.useRegex()}
                                onChange={(e) => strings.setUseRegex(e.currentTarget.checked)}
                            />
                            Regex
                        </label>
                    </div>

                    {/* Progress bar */}
                    <Show when={strings.status() === "scanning"}>
                        <div class="strings-progress-track">
                            <div
                                class="strings-progress-fill"
                                style={{ width: `${progressPercent()}%` }}
                            />
                        </div>
                    </Show>

                    <Show when={!app.attached()}>
                        <p class="strings-warn">no process attached.</p>
                    </Show>
                </div>

                {/* Virtualized table */}
                <div class="panel-body">
                    <div class="strings-table-wrap">
                        {/* Table header */}
                        <div class="strings-thead">
                            <span
                                class="strings-col strings-col-addr"
                                onClick={() => strings.toggleSort("address")}
                            >
                                Address{sortIndicator("address")}
                            </span>
                            <span
                                class="strings-col strings-col-len"
                                onClick={() => strings.toggleSort("length")}
                            >
                                Length{sortIndicator("length")}
                            </span>
                            <span
                                class="strings-col strings-col-type"
                                onClick={() => strings.toggleSort("type")}
                            >
                                Type{sortIndicator("type")}
                            </span>
                            <span
                                class="strings-col strings-col-value"
                                onClick={() => strings.toggleSort("value")}
                            >
                                String{sortIndicator("value")}
                            </span>
                        </div>

                        {/* Virtualized rows */}
                        <div
                            ref={setRef}
                            class="strings-body list"
                        >
                            <div
                                style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
                            >
                                <For each={virtualizer.getVirtualItems()}>
                                    {(vRow) => {
                                        const entry = () => strings.filteredStrings()[vRow.index];
                                        return (
                                            <div
                                                class="strings-row"
                                                style={{
                                                    position: "absolute",
                                                    top: `${vRow.start}px`,
                                                    left: 0,
                                                    right: 0,
                                                    height: `${ROW_HEIGHT}px`,
                                                }}
                                                onClick={() => createClass(entry().address)}
                                                title="click to create a memory class at this address"
                                            >
                                                <span class="strings-col strings-col-addr addr">
                                                    {entry().address}
                                                </span>
                                                <span class="strings-col strings-col-len dim">
                                                    {entry().charCount}
                                                </span>
                                                <span class="strings-col strings-col-type">
                                                    <span
                                                        class="strings-type-badge"
                                                        classList={{
                                                            ascii: entry().type === "ascii",
                                                            utf16: entry().type === "utf16",
                                                        }}
                                                    >
                                                        {entry().type === "ascii" ? "A" : "U"}
                                                    </span>
                                                </span>
                                                <span class="strings-col strings-col-value">
                                                    {entry().value}
                                                </span>
                                            </div>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    </div>
                    <StatusOverlay message={overlayMessage()} error={strings.status() === "error"} />
                </div>
            </section>
        </div>
    );
}
