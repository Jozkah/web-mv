import { For, Show, createMemo, createSignal } from "solid-js";
import { useApp } from "../../app/AppContext";
import { useStatic } from "../static/state/StaticContext";
import { useMemory } from "../memory/state/MemoryContext";
import type { HistoryItem } from "../../state/historyStore";
import "./history.css";

type CategoryFilter = "all" | "function" | "scan" | "memory";

export function HistoryView() {
    const app = useApp();
    const [searchQuery, setSearchQuery] = createSignal("");
    const [categoryFilter, setCategoryFilter] = createSignal<CategoryFilter>("all");

    // Optional context providers might be undefined if history is viewed standalone
    let staticState: ReturnType<typeof useStatic> | undefined;
    let memoryState: ReturnType<typeof useMemory> | undefined;
    try {
        staticState = useStatic();
    } catch {
        /* no static context */
    }
    try {
        memoryState = useMemory();
    } catch {
        /* no memory context */
    }

    const filteredItems = createMemo(() => {
        const items = app.history.items;
        const q = searchQuery().trim().toLowerCase();
        const cat = categoryFilter();

        return items.filter((item) => {
            // Category filter
            if (cat === "function" && item.type !== "function") return false;
            if (cat === "scan" && item.type !== "scan" && item.type !== "string_scan") return false;
            if (cat === "memory" && item.type !== "memory") return false;

            // Search query filter
            if (!q) return true;

            switch (item.type) {
                case "function":
                    return (
                        (item.module && item.module.toLowerCase().includes(q)) ||
                        (item.address && item.address.toLowerCase().includes(q)) ||
                        (item.rva && item.rva.toLowerCase().includes(q)) ||
                        (item.name && item.name.toLowerCase().includes(q))
                    );
                case "scan":
                    return (
                        item.pattern.toLowerCase().includes(q) ||
                        item.scope.toLowerCase().includes(q) ||
                        item.kind.toLowerCase().includes(q)
                    );
                case "memory":
                    return (
                        item.className.toLowerCase().includes(q) ||
                        item.address.toLowerCase().includes(q) ||
                        item.classId.toLowerCase().includes(q)
                    );
                case "string_scan":
                    return item.module.toLowerCase().includes(q);
            }
        });
    });

    const formatTimeAgo = (timestamp: number): string => {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        if (seconds < 60) return "just now";
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    };

    const handleItemClick = (item: HistoryItem) => {
        switch (item.type) {
            case "function":
                app.setActiveView("static");
                if (staticState) {
                    if (item.rva) {
                        staticState.openPinned(item.module, item.rva);
                    } else if (item.address) {
                        staticState.openAddress(item.address);
                    }
                }
                break;
            case "scan":
            case "string_scan":
                app.setActiveView("strings");
                break;
            case "memory":
                app.setActiveView("memory", item.classId);
                if (memoryState && item.classId) {
                    memoryState.selectClass(item.classId);
                }
                break;
        }
    };

    const handleClearAll = () => {
        if (app.history.items.length === 0) return;
        if (confirm("Are you sure you want to clear all history?")) {
            app.history.clearAll();
        }
    };

    return (
        <div class="history-view">
            <section class="history-panel">
                <div class="history-toolbar">
                    <input
                        class="history-search-input"
                        type="text"
                        placeholder="Filter history by module, address, pattern, class name..."
                        value={searchQuery()}
                        onInput={(e) => setSearchQuery(e.currentTarget.value)}
                    />

                    <div class="history-category-tabs">
                        <button
                            class="history-cat-btn"
                            classList={{ active: categoryFilter() === "all" }}
                            onClick={() => setCategoryFilter("all")}
                        >
                            All ({app.history.items.length})
                        </button>
                        <button
                            class="history-cat-btn"
                            classList={{ active: categoryFilter() === "function" }}
                            onClick={() => setCategoryFilter("function")}
                        >
                            Functions
                        </button>
                        <button
                            class="history-cat-btn"
                            classList={{ active: categoryFilter() === "scan" }}
                            onClick={() => setCategoryFilter("scan")}
                        >
                            Scans
                        </button>
                        <button
                            class="history-cat-btn"
                            classList={{ active: categoryFilter() === "memory" }}
                            onClick={() => setCategoryFilter("memory")}
                        >
                            Memory
                        </button>
                    </div>

                    <button class="history-clear-btn" onClick={handleClearAll} title="Clear all history entries">
                        Clear History
                    </button>
                </div>

                <div class="history-list">
                    <For each={filteredItems()}>
                        {(item) => (
                            <div class="history-item-card" onClick={() => handleItemClick(item)}>
                                <SwitchCategoryBadge type={item.type} />

                                <div class="history-item-content">
                                    <SwitchItemDetails item={item} />
                                </div>

                                <div class="history-item-meta">
                                    <span class="history-time">{formatTimeAgo(item.timestamp)}</span>
                                    <button
                                        class="history-delete-btn"
                                        title="Remove entry"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            app.history.removeItem(item.id);
                                        }}
                                    >
                                        ×
                                    </button>
                                </div>
                            </div>
                        )}
                    </For>

                    <Show when={filteredItems().length === 0}>
                        <div class="history-empty">
                            <span class="history-empty-icon">📜</span>
                            <p>
                                {app.history.items.length === 0
                                    ? "No history entries yet. View functions, run scans, or inspect memory classes to populate history."
                                    : "No history items match your search filter."}
                            </p>
                        </div>
                    </Show>
                </div>
            </section>
        </div>
    );
}

function SwitchCategoryBadge(props: { type: HistoryItem["type"] }) {
    switch (props.type) {
        case "function":
            return <div class="history-icon-badge badge-function" title="Function">⚡</div>;
        case "scan":
            return <div class="history-icon-badge badge-scan" title="Signature Scan">🎯</div>;
        case "memory":
            return <div class="history-icon-badge badge-memory" title="Memory Class">🧠</div>;
        case "string_scan":
            return <div class="history-icon-badge badge-string" title="String Scan">🧵</div>;
    }
}

function SwitchItemDetails(props: { item: HistoryItem }) {
    const item = props.item;
    switch (item.type) {
        case "function":
            return (
                <>
                    <div class="history-item-title">
                        <span>{item.name || (item.rva ? `sub_${item.rva}` : (item.address || "function"))}</span>
                        <span class="history-tag">{item.module}</span>
                    </div>
                    <div class="history-item-subtitle">
                        Address: {item.address || "unknown"}{item.rva ? ` (RVA: +0x${item.rva})` : ""}
                    </div>
                </>
            );
        case "scan":
            return (
                <>
                    <div class="history-item-title">
                        <span>Signature Scan: {item.pattern}</span>
                        <span class="history-tag">{item.scope}</span>
                    </div>
                    <div class="history-item-subtitle">
                        Hits: {item.hitCount} {item.findAll ? "(find all)" : "(first match)"}
                    </div>
                </>
            );
        case "memory":
            return (
                <>
                    <div class="history-item-title">
                        <span>Class: {item.className}</span>
                    </div>
                    <div class="history-item-subtitle">
                        {item.address ? `Address: ${item.address}` : "Unattached class"}
                    </div>
                </>
            );
        case "string_scan":
            return (
                <>
                    <div class="history-item-title">
                        <span>String Scan</span>
                        <span class="history-tag">{item.module}</span>
                    </div>
                    <div class="history-item-subtitle">
                        Found {item.stringCount} strings in module
                    </div>
                </>
            );
    }
}
