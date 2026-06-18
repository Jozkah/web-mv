import { createEffect, untrack } from "solid-js";
import { useApp } from "../../app/AppContext";
import { StatusOverlay } from "../../ui/StatusOverlay";
import { readBatch } from "../../protocol/requests";
import { totalSize } from "./nodes/layout";
import { planGuesses } from "./nodes/guess";
import { type GuessField } from "./nodes/types";
import { useMemory } from "./state/MemoryContext";
import { regionKey, useMemorySnapshot } from "./state/useMemorySnapshot";
import { ClassSidebar } from "./components/ClassSidebar";
import { AddressBar } from "./components/AddressBar";
import { NodeGrid } from "./components/NodeGrid";
import { MemoryFooter } from "./components/MemoryFooter";

// The memory viewer ("dynamic" analysis): a class sidebar, an address bar, and the live node
// grid for the active class. The poll lives here so it only runs while this view is mounted;
// the class definitions persist in the provider above the view switch.
//
// Switching/deleting a class is a pure synchronous store update the grid re-renders from; it
// never touches the network. The poll reads the new region in the background and supersedes any
// in-flight read on a switch (see useMemorySnapshot), so it can't block or stall the UI.

export function MemoryView() {
    const app = useApp();
    const memory = useMemory();

    const activeClass = () => memory.activeClass();
    const nodes = () => activeClass()?.nodes ?? [];
    const baseAddress = () => activeClass()?.address ?? "";
    const size = () => totalSize(nodes());

    const enabled = () => app.attached();
    const poll = useMemorySnapshot(app.client, activeClass, enabled);

    // Hand the grid (and guesser) a snapshot only while it still matches the active class, so a
    // switch clears the old bytes instead of briefly showing them against the new class's rows.
    const snapshot = () => {
        const s = poll.data();
        const cls = activeClass();
        if (!s || !cls) return s;
        return s.key === regionKey(cls) ? s : undefined;
    };

    // ReClass-style auto-guess over the live bytes: classify every untyped tile (pointer / float
    // / int / uint / bool / string). Pointer candidates are user-mode addresses, each confirmed
    // with one batch read so we never label unmapped junk a pointer; a failed follow-check falls
    // back to the numeric guess, and the next poll fills in the new pointers' previews + RTTI.
    //
    // planGuesses only ever targets untyped fills, and applyGuesses only retypes a tile that is
    // STILL such a fill. So a guess can never override a hand-typed field, and once a tile is
    // typed it drops out of future plans - no visited-range bookkeeping needed, it just converges.
    let guessing = false;

    const autoGuess = async () => {
        if (guessing) return;
        const snap = poll.data();
        const cls = activeClass();
        if (!snap || !cls || !app.attached()) return;

        // Only guess against a snapshot that matches the active region (the poll can lag a switch).
        const planRegion = regionKey(cls);
        if (snap.key !== planRegion) return;

        const plan = planGuesses(cls.nodes, snap.view);
        if (plan.length === 0) return;

        guessing = true;
        try {
            const candidates = plan.filter((p) => p.pointerTarget);
            const confirmed = new Set<string>();
            if (candidates.length > 0) {
                let batch;
                try {
                    batch = await readBatch(app.client, {
                        reads: candidates.map((c) => ({ address: c.pointerTarget!, size: 8 })),
                    });
                } catch {
                    return; // agent hiccup mid-guess: retry on the next snapshot
                }
                candidates.forEach((c, i) => batch.results[i]?.success && confirmed.add(c.nodeId));
            }

            const final = new Map<string, GuessField[]>();
            for (const p of plan) {
                if (confirmed.has(p.nodeId)) final.set(p.nodeId, ["pointer"]);
                else if (p.types.length > 0) final.set(p.nodeId, p.types);
            }

            // Drop everything if the region changed during the confirm read (switch, edit, resize);
            // applyGuesses additionally leaves alone any tile the user has typed in the meantime.
            if (regionKey(activeClass()) === planRegion) memory.applyGuesses(final);
        } finally {
            guessing = false;
        }
    };

    // Re-guess on each fresh snapshot. untrack keeps it from subscribing to the node/active-class
    // reads it makes; typed tiles drop out of the plan, so steady state is a cheap no-op.
    createEffect(() => {
        poll.data();
        untrack(() => void autoGuess());
    });

    return (
        <div class="memory-view">
            <ClassSidebar />
            <div class="memory-main">
                <AddressBar />
                <div class="memory-body">
                    <NodeGrid nodes={nodes} baseAddress={baseAddress} snapshot={snapshot} />

                    <StatusOverlay message={!activeClass() && "create a class to begin"} />
                    <StatusOverlay message={!!activeClass() && baseAddress() === "" && "enter an address to read memory"} />
                    <StatusOverlay message={baseAddress() !== "" && !app.attached() && "agent not attached"} />
                    <StatusOverlay message={app.attached() && poll.error()?.message} error />
                </div>
                <MemoryFooter nodes={nodes} size={size} />
            </div>
        </div>
    );
}
