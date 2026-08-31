import { createSignal } from "solid-js";
import { ModulesList } from "./components/ModulesList";
import { PinnedList } from "./components/PinnedList";
import { FunctionList } from "./components/FunctionList";
import { DisassemblyView } from "./components/DisassemblyView";
import { XrefPanel } from "./components/XrefPanel";
import { PaneResizer } from "./components/PaneResizer";
import { load, save } from "../../state/persist";
import "./xref.css";

// The static-analysis view: a three-pane workspace - a rail of modules + pinned functions,
// the function list for the selected module, and the disassembly of the selected function.
// Layout only, plus the two draggable seams (rail | functions | disasm) whose widths persist.

const PANES_KEY = "ax.static.panes";
const PANES_VER = 1;
interface PaneSizes {
    railW?: number;
    fnW?: number;
}

export function StaticView() {
    const initial = load<PaneSizes>(PANES_KEY, PANES_VER) ?? {};
    const num = (v: unknown) => (typeof v === "number" && isFinite(v) && v > 0 ? v : undefined);
    const [railW, setRailW] = createSignal<number | undefined>(num(initial.railW));
    const [fnW, setFnW] = createSignal<number | undefined>(num(initial.fnW));

    // Persist only on release (commit), never on the per-frame live updates during a drag.
    const persist = () => save(PANES_KEY, PANES_VER, { railW: railW(), fnW: fnW() });

    return (
        <div class="sv-workspace">
            <div class="sv-rail" style={railW() !== undefined ? { flex: `0 0 ${railW()}px` } : undefined}>
                <ModulesList />
                <PinnedList />
            </div>
            <PaneResizer
                min={160}
                max={520}
                onInput={setRailW}
                onCommit={(w) => {
                    setRailW(w);
                    persist();
                }}
            />
            <FunctionList width={fnW()} />
            <PaneResizer
                min={260}
                max={720}
                onInput={setFnW}
                onCommit={(w) => {
                    setFnW(w);
                    persist();
                }}
            />
            <DisassemblyView />
            <XrefPanel />
        </div>
    );
}
