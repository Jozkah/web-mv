import { createSignal } from "solid-js";

// What the user is currently looking at in the static-analysis view. Raw reactive signals
// only - the coordinated actions that set them (and the async resolution of a pin into a
// concrete function) live in StaticContext, which has the caches needed to do it.

/** A concrete, fully-resolved function the disassembly panel can act on. */
export interface FunctionRef {
    module: string;
    rva: string;
    address: string;
    size: number;
}

export function createSelection() {
    const [selectedModule, setSelectedModule] = createSignal<string | null>(null);
    const [selectedFunction, setSelectedFunction] = createSignal<FunctionRef | null>(null);
    // A pin click knows (module, RVA) immediately but not the function's size until that
    // module's list has loaded; this holds the request until the resolver can fill it in.
    const [pendingRva, setPendingRva] = createSignal<{ module: string; rva: string } | null>(null);
    // Same idea for an external jump to an absolute address (e.g. a scan hit): we know the
    // module and the hit address up front, but need the loaded function list to find which
    // function contains it. Held here until the resolver in StaticContext can complete it.
    const [pendingAddress, setPendingAddress] = createSignal<{ module: string; address: string } | null>(null);

    return {
        selectedModule,
        setSelectedModule,
        selectedFunction,
        setSelectedFunction,
        pendingRva,
        setPendingRva,
        pendingAddress,
        setPendingAddress,
    };
}

export type Selection = ReturnType<typeof createSelection>;
