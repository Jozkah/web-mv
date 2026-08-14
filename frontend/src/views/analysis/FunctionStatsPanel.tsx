import { Show, createMemo } from "solid-js";
import { useApp } from "../../app/AppContext";
import { useStatic } from "../static/state/StaticContext";
import { Panel } from "../../ui/Panel";
import { StatusOverlay } from "../../ui/StatusOverlay";
import { computeFunctionStats } from "../static/state/analysisXref";
import { functionLabel } from "./label";

// Function-boundary auto-analysis summary for the selected module: how many functions were
// enumerated, how many carry a known size, how much of their address span is actually
// covered, and how large the un-analysed gaps between them are. A quick read on how complete
// the agent's function recovery is for this module.

function fmtBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
}

export function FunctionStatsPanel() {
    const { modules, annotations, setActiveView } = useApp();
    const { selection, functions, openAddress } = useStatic();

    const module = () => selection.selectedModule();
    const moduleFns = () => {
        const m = module();
        const e = m ? functions.get(m) : undefined;
        return e?.status === "ready" ? e.data : [];
    };

    const stats = createMemo(() => computeFunctionStats(moduleFns()));

    const largestLabel = () => {
        const m = module();
        const b = m ? modules.baseOf(m) : undefined;
        const largest = stats().largest;
        return m && b && largest ? functionLabel(annotations, m, b, largest.address) : "-";
    };

    const gotoLargest = () => {
        const largest = stats().largest;
        if (largest) {
            openAddress(largest.address);
            setActiveView("static");
        }
    };

    return (
        <Panel
            class="ana-panel"
            title="function stats"
            meta={<Show when={module()} fallback="no module">{(m) => m()}</Show>}
        >
            <div class="panel-body ana-stats">
                <Show when={module() && moduleFns().length} fallback={<StatusOverlay message="select a module with enumerated functions" />}>
                    <div class="ana-stat-grid">
                        <div class="ana-stat"><span class="ana-stat-k">functions</span><span class="ana-stat-v">{stats().count.toLocaleString()}</span></div>
                        <div class="ana-stat"><span class="ana-stat-k">sized</span><span class="ana-stat-v">{stats().sized.toLocaleString()}</span></div>
                        <div class="ana-stat"><span class="ana-stat-k">unsized</span><span class="ana-stat-v">{stats().unsized.toLocaleString()}</span></div>
                        <div class="ana-stat"><span class="ana-stat-k">code bytes</span><span class="ana-stat-v">{fmtBytes(stats().totalBytes)}</span></div>
                        <div class="ana-stat"><span class="ana-stat-k">span</span><span class="ana-stat-v">{fmtBytes(stats().spanBytes)}</span></div>
                        <div class="ana-stat"><span class="ana-stat-k">coverage</span><span class="ana-stat-v">{(stats().coverage * 100).toFixed(1)}%</span></div>
                        <div class="ana-stat"><span class="ana-stat-k">gaps</span><span class="ana-stat-v">{stats().gapCount.toLocaleString()}</span></div>
                        <div class="ana-stat"><span class="ana-stat-k">gap bytes</span><span class="ana-stat-v">{fmtBytes(stats().gapBytes)}</span></div>
                    </div>

                    <div class="ana-coverage-track" title={`${(stats().coverage * 100).toFixed(1)}% of the code span is inside an enumerated function`}>
                        <div class="ana-coverage-fill" style={{ width: `${Math.min(100, stats().coverage * 100)}%` }} />
                    </div>

                    <Show when={stats().largest}>
                        <button class="ana-node ana-largest" onClick={gotoLargest} title="jump to the largest function">
                            <span class="ana-node-name">largest: {largestLabel()}</span>
                            <span class="dim">{fmtBytes(stats().largest!.size)}</span>
                        </button>
                    </Show>
                </Show>
            </div>
        </Panel>
    );
}
