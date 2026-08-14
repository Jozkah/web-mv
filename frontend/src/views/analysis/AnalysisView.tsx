import { CallGraphPanel } from "./CallGraphPanel";
import { CfgPanel } from "./CfgPanel";
import { ImmediateSearchPanel } from "./ImmediateSearchPanel";
import { FunctionStatsPanel } from "./FunctionStatsPanel";
import "./analysis.css";

// The static-analysis workbench tab: four panels over the current static selection - call
// graph, control-flow graph, operand search and module function stats. All state is read
// from the shared static context, so the selection made in the Modules tab drives every
// panel here.

export function AnalysisView() {
    return (
        <div class="analysis-view">
            <div class="analysis-col">
                <CallGraphPanel />
                <ImmediateSearchPanel />
            </div>
            <div class="analysis-col">
                <CfgPanel />
            </div>
            <div class="analysis-col analysis-col-narrow">
                <FunctionStatsPanel />
            </div>
        </div>
    );
}
