import { type Accessor } from "solid-js";
import { type Node } from "../nodes/types";
import { useMemory } from "../state/MemoryContext";

// Footer: layout stats only. Nodes are added/typed from the row right-click menu, and type
// guessing runs automatically over untyped tiles (see MemoryView), so the footer needs no
// controls.

export function MemoryFooter(props: { nodes: Accessor<Node[]>; size: Accessor<number> }) {
    const memory = useMemory();
    const selectedCount = () => memory.selectedNodeIds.length;

    return (
        <div class="memory-footer">
            <span class="footer-stats">
                {props.nodes().length} nodes · {props.size()} bytes · {selectedCount()} selected
            </span>
        </div>
    );
}
