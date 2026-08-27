import { createContext, createMemo, createSignal, useContext, type JSX } from "solid-js";
import { useApp } from "../../../app/AppContext";
import { scanModuleStrings, type ScanProgress } from "../scanModule";
import type { StringCategory, StringEntry } from "../extractStrings";
import * as csv from "../../../ui/csv";

export type ScanStatus = "idle" | "scanning" | "ready" | "error";

export type SortColumn = "address" | "length" | "type" | "value";
export type SortDir = "asc" | "desc";
export type EncodingFilter = "all" | "ascii" | "utf16";
export type CategoryFilter = "all" | StringCategory;

function createStringsState() {
    const { client, attached, history } = useApp();

    const [selectedModule, setSelectedModule] = createSignal("");
    const [allStrings, setAllStrings] = createSignal<StringEntry[]>([]);
    const [status, setStatus] = createSignal<ScanStatus>("idle");
    const [error, setError] = createSignal("");
    const [progress, setProgress] = createSignal<ScanProgress>({ fraction: 0, found: 0 });

    // Filtering
    const [filter, setFilter] = createSignal("");
    const [useRegex, setUseRegex] = createSignal(false);
    const [minLength, setMinLength] = createSignal(4);
    const [encodingFilter, setEncodingFilter] = createSignal<EncodingFilter>("all");
    const [categoryFilter, setCategoryFilter] = createSignal<CategoryFilter>("all");

    // Sorting
    const [sortColumn, setSortColumn] = createSignal<SortColumn>("address");
    const [sortDir, setSortDir] = createSignal<SortDir>("asc");

    // Module result cache: key = `moduleName@moduleBase:minLength`
    const scanCache = new Map<string, StringEntry[]>();

    let abortController: AbortController | null = null;

    const toggleSort = (col: SortColumn) => {
        if (sortColumn() === col) {
            setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortColumn(col);
            setSortDir("asc");
        }
    };

    // Filtered view of the strings
    const filteredStrings = createMemo(() => {
        let list = allStrings();

        // Encoding filter
        const enc = encodingFilter();
        if (enc !== "all") list = list.filter((s) => s.type === enc);

        // Category filter
        const cat = categoryFilter();
        if (cat !== "all") list = list.filter((s) => s.category === cat);

        // Text filter (plain substring or regex)
        const q = filter().trim();
        if (!q) return list;

        try {
            if (useRegex()) {
                const rx = new RegExp(q, "i");
                return list.filter((s) => rx.test(s.value) || rx.test(s.address));
            } else {
                const lower = q.toLowerCase();
                return list.filter(
                    (s) => s.value.toLowerCase().includes(lower) || s.address.toLowerCase().includes(lower),
                );
            }
        } catch {
            return list;
        }
    });

    const sortedStrings = createMemo(() => {
        const list = filteredStrings();
        const col = sortColumn();
        const dir = sortDir();
        const mul = dir === "asc" ? 1 : -1;

        const sorted = [...list].sort((a, b) => {
            switch (col) {
                case "address": {
                    if (a.address.length !== b.address.length)
                        return mul * (a.address.length - b.address.length);
                    return mul * (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
                }
                case "length":
                    return mul * (a.charCount - b.charCount);
                case "type":
                    return mul * a.type.localeCompare(b.type);
                case "value":
                    return mul * a.value.localeCompare(b.value);
            }
        });

        return sorted;
    });

    async function scan(moduleName: string, moduleBase: string, moduleSize: number) {
        if (status() === "scanning") return;
        if (!attached()) return;

        setSelectedModule(moduleName);

        const cacheKey = `${moduleName}@${moduleBase}:${minLength()}`;
        if (scanCache.has(cacheKey)) {
            const cached = scanCache.get(cacheKey)!;
            setAllStrings(cached);
            setStatus("ready");
            history.addStringScan({ module: moduleName, stringCount: cached.length });
            return;
        }

        abortController?.abort();
        abortController = new AbortController();

        setAllStrings([]);
        setStatus("scanning");
        setError("");
        setProgress({ fraction: 0, found: 0 });

        try {
            const results = await scanModuleStrings(
                client,
                moduleBase,
                moduleSize,
                minLength(),
                abortController.signal,
                (p) => setProgress(p),
            );
            scanCache.set(cacheKey, results);
            setAllStrings(results);
            setStatus("ready");
            history.addStringScan({ module: moduleName, stringCount: results.length });
        } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
                setStatus("idle");
            } else {
                setError(e instanceof Error ? e.message : String(e));
                setStatus("error");
            }
        }
    }

    function cancel() {
        abortController?.abort();
        abortController = null;
    }

    function downloadFile(content: string, filename: string, type: string) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportCsv() {
        // RFC-4180 via the shared serializer. `value` is raw target-string data → formula-guarded; the
        // address is a canonical token and type/category are controlled enums.
        const rows = filteredStrings().map((r) => [csv.raw(r.address), csv.num(r.charCount), csv.raw(r.type), csv.raw(r.category), csv.text(r.value)]);
        const body = csv.serializeCsv(rows, { header: ["Address", "Length", "Type", "Category", "Value"] });
        downloadFile(body, `${selectedModule() || "strings"}_export.csv`, "text/csv");
    }

    function exportJson() {
        const content = JSON.stringify(filteredStrings(), null, 2);
        downloadFile(content, `${selectedModule() || "strings"}_export.json`, "application/json");
    }

    function exportTxt() {
        const content = filteredStrings()
            .map((r) => `${r.address}\t${r.type}\t${r.value}`)
            .join("\n");
        downloadFile(content, `${selectedModule() || "strings"}_export.txt`, "text/plain");
    }

    return {
        selectedModule,
        allStrings,
        filteredStrings,
        sortedStrings,
        status,
        error,
        progress,
        filter,
        setFilter,
        useRegex,
        setUseRegex,
        minLength,
        setMinLength,
        encodingFilter,
        setEncodingFilter,
        categoryFilter,
        setCategoryFilter,
        sortColumn,
        sortDir,
        toggleSort,
        scan,
        cancel,
        exportCsv,
        exportJson,
        exportTxt,
    };
}

export type StringsState = ReturnType<typeof createStringsState>;

const StringsContext = createContext<StringsState>();

export function StringsProvider(props: { children: JSX.Element }) {
    const state = createStringsState();
    return <StringsContext.Provider value={state}>{props.children}</StringsContext.Provider>;
}

export function useStrings(): StringsState {
    const state = useContext(StringsContext);
    if (!state) throw new Error("useStrings must be used within a StringsProvider");
    return state;
}
