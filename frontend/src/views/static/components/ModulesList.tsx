import { For, createMemo, createSignal } from "solid-js";
import { useApp } from "../../../app/AppContext";
import { useStatic } from "../state/StaticContext";
import { filterModules } from "../../../state/modulesStore";
import { Panel } from "../../../ui/Panel";
import { StatusOverlay } from "../../../ui/StatusOverlay";

// Left rail (top): the attached process's modules. Reads the shared modules store (loaded
// once on attach) and selects a module, which kicks off its function enumerate. The
// refresh button re-fetches on demand.

export function ModulesList() {
    const { modules } = useApp();
    const { selection, selectModule } = useStatic();

    const [query, setQuery] = createSignal("");
    const filtered = createMemo(() => filterModules(modules.list(), query()));

    return (
        <Panel
            class="panel-modules"
            title="modules"
            meta={filtered().length || ""}
            actions={
                <button onClick={() => modules.load()} disabled={modules.status() === "loading"}>
                    refresh
                </button>
            }
        >
            <div class="searchbar">
                <input
                    class="search"
                    type="text"
                    placeholder="search module"
                    value={query()}
                    onInput={(e) => setQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Escape") setQuery("");
                    }}
                />
            </div>

            <div class="panel-body">
                <div class="list">
                    <For each={filtered()}>
                        {(m) => (
                            <div
                                class="row"
                                classList={{ selected: selection.selectedModule() === m.name }}
                                onClick={() => selectModule(m.name)}
                            >
                                <span class="grow" title={m.name}>
                                    {m.name}
                                </span>
                                <span class="addr">{m.base}</span>
                            </div>
                        )}
                    </For>
                </div>

                <StatusOverlay
                    error={modules.status() === "error"}
                    message={
                        modules.list().length === 0 &&
                        (modules.status() === "loading"
                            ? "loading modules…"
                            : modules.status() === "error"
                              ? modules.error()
                              : "no modules found")
                    }
                />
            </div>
        </Panel>
    );
}
