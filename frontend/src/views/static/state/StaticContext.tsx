import { createContext, createEffect, on, useContext, type JSX } from "solid-js";
import { useApp } from "../../../app/AppContext";
import { addressOf, parseHex, rvaOf } from "../../../state/address";
import { createFunctionsCache } from "./functionsCache";
import { createDisassemblyCache } from "./disassemblyCache";
import { createSelection } from "./selection";

// The static-analysis view's own state: the per-module function lists, per-function
// disassembly, the current selection, and the intent-level actions that coordinate them
// against the shared app state. Lives only as long as the static view is provided; the
// shared module list and annotations it builds on come from useApp().

function createStaticState() {
    const { client, modules, base, annotations, history } = useApp();

    const functions = createFunctionsCache(client);
    const disasm = createDisassemblyCache(client);
    const selection = createSelection();

    function selectModule(name: string) {
        selection.setSelectedModule(name);
        functions.ensure(name); // fetch-once; no-op if already cached
    }

    function selectFunction(module: string, entry: { address: string; size: number }) {
        const moduleBase = modules.baseOf(module);
        if (!moduleBase) return;
        const rva = rvaOf(moduleBase, entry.address);
        selection.setPendingRva(null);
        selection.setSelectedFunction({
            module,
            rva,
            address: entry.address,
            size: entry.size,
        });

        const customName = annotations.hasCustomName(module, rva) ? annotations.nameOf(module, rva) : undefined;
        history.addFunction({
            module,
            rva,
            address: entry.address,
            name: customName,
            size: entry.size,
        });
    }

    // Jump to a pinned function, possibly in a different module. We can switch module and
    // start its enumerate immediately, but the function's size only exists once the list
    // arrives - so we stash the target and let the resolver below complete it.
    function openPinned(module: string, rva: string) {
        selection.setSelectedModule(module);
        functions.ensure(module);
        selection.setPendingRva({ module, rva });
    }

    // Jump to whatever function contains an absolute address (e.g. a sig/string scan hit).
    // Resolve which module owns the address from the shared module list, switch to it and
    // start its enumerate; the resolver below selects the containing function once the list
    // lands. Falls back to just selecting the module if nothing contains the hit.
    function openAddress(address: string) {
        const addr = parseHex(address);
        const owner = modules.list().find((m) => {
            const start = parseHex(m.base);
            return addr >= start && addr < start + BigInt(m.size);
        });
        if (!owner) return;

        selection.setSelectedModule(owner.name);
        functions.ensure(owner.name);
        selection.setPendingAddress({ module: owner.name, address });
    }

    // Resolve a pending pin target once its module's functions are cached.
    createEffect(() => {
        const pending = selection.pendingRva();
        if (!pending || !pending.module || !pending.rva) return;

        const entry = functions.get(pending.module);
        if (entry?.status !== "ready") return; // wait for the enumerate to land (or error)

        selection.setPendingRva(null);
        const moduleBase = modules.baseOf(pending.module);
        if (!moduleBase) return;

        const target = addressOf(moduleBase, pending.rva);
        const fn = entry.data.find((f) => f.address === target);
        if (fn) {
            selection.setSelectedFunction({ module: pending.module, rva: pending.rva, address: fn.address, size: fn.size });
        }
    });

    // Resolve a pending address jump once its module's functions are cached: select the
    // function whose [address, address + size) contains the hit. If none does (the hit sits
    // outside any enumerated function), the module stays selected and we just clear the pin.
    createEffect(() => {
        const pending = selection.pendingAddress();
        if (!pending) return;

        const entry = functions.get(pending.module);
        if (entry?.status !== "ready") return;

        selection.setPendingAddress(null);

        const addr = parseHex(pending.address);
        const fn = entry.data.find((f) => {
            const start = parseHex(f.address);
            return addr >= start && addr < start + BigInt(f.size);
        });
        if (fn) selectFunction(pending.module, fn);
    });

    // Process re-attached (the shared base changed): absolute addresses moved, so the
    // address-keyed caches and the selection are stale. Drop them. Annotations are keyed
    // by RVA (shared, in useApp) and intentionally survive. Deferred so mounting the view
    // does not wipe a selection made before the view was shown.
    createEffect(
        on(
            base,
            () => {
                functions.clear();
                disasm.clear();
                selection.setSelectedFunction(null);
                selection.setPendingRva(null);
                selection.setPendingAddress(null);
            },
            { defer: true },
        ),
    );

    return { functions, disasm, selection, selectModule, selectFunction, openPinned, openAddress };
}

export type StaticState = ReturnType<typeof createStaticState>;

const StaticContext = createContext<StaticState>();

export function StaticProvider(props: { children: JSX.Element }) {
    const state = createStaticState();
    return <StaticContext.Provider value={state}>{props.children}</StaticContext.Provider>;
}

export function useStatic(): StaticState {
    const state = useContext(StaticContext);
    if (!state) throw new Error("useStatic must be used within a StaticProvider");
    return state;
}
