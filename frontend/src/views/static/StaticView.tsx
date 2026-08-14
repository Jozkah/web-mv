import { ModulesList } from "./components/ModulesList";
import { PinnedList } from "./components/PinnedList";
import { FunctionList } from "./components/FunctionList";
import { DisassemblyView } from "./components/DisassemblyView";
import { XrefPanel } from "./components/XrefPanel";
import "./xref.css";

// The static-analysis view: a three-pane workspace - a rail of modules + pinned functions,
// the function list for the selected module, and the disassembly of the selected function.
// All state comes from the static/app contexts; this is pure layout.

export function StaticView() {
    return (
        <div class="workspace">
            <div class="rail">
                <ModulesList />
                <PinnedList />
            </div>
            <FunctionList />
            <DisassemblyView />
            <XrefPanel />
        </div>
    );
}
