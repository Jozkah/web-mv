import { createContext, createEffect, createSignal, on, useContext, type JSX } from "solid-js";
import { useApp } from "../../../app/AppContext";
import { addressOf, parseHex, rvaOf } from "../../../state/address";
import { disassemble } from "../../../protocol/requests";
import { createFunctionsCache } from "./functionsCache";
import { createDisassemblyCache } from "./disassemblyCache";
import { createAnalysisIndex } from "./analysisIndex";
import { functionsReferencingAddress } from "./analysisXref";
import { createSelection } from "./selection";
import { createXrefIndex } from "./xref";

// The static-analysis view's own state: the per-module function lists, per-function
// disassembly, the current selection, and the intent-level actions that coordinate them
// against the shared app state. Lives only as long as the static view is provided; the
// shared module list and annotations it builds on come from useApp().

function createStaticState() {
    const { client, modules, base, annotations, history } = useApp();

    const functions = createFunctionsCache(client);
    const disasm = createDisassemblyCache(client);
    const analysis = createAnalysisIndex(client);
    const selection = createSelection();
    const xref = createXrefIndex();

    // Full-module xref build progress. Building the incoming-reference index for a whole module
    // means decoding every enumerated function - potentially thousands of RPCs - so it is an
    // explicit, cancellable, progress-reporting action, never an implicit hang.
    const [buildState, setBuildState] = createSignal<{ running: boolean; done: number; total: number }>({
        running: false,
        done: 0,
        total: 0,
    });
    let buildToken = 0;

    const nameOfFn = (module: string, address: string): string | undefined => {
        const b = modules.baseOf(module);
        if (!b) return undefined;
        const rva = rvaOf(b, address);
        return annotations.hasCustomName(module, rva) ? annotations.nameOf(module, rva) : undefined;
    };

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

    // A string/data address whose referencing function we want to pivot to. Resolving it
    // needs the whole module xref index, so this may kick a build and wait for it - the
    // effect below drives the multi-stage async (functions -> index -> jump). Used by the
    // strings view's "xref" action.
    const [pendingXref, setPendingXref] = createSignal<{ module: string; address: string } | null>(null);

    // Kick off a pivot from an arbitrary address (e.g. a string) to the function(s) that
    // reference it. Ensures the module's functions are enumerated; the effect completes the
    // rest once the enumerate (and, if needed, the index build) lands.
    function pivotAddressXref(module: string, address: string) {
        selection.setSelectedModule(module);
        functions.ensure(module);
        setPendingXref({ module, address });
    }

    createEffect(() => {
        const pending = pendingXref();
        if (!pending) return;

        const fe = functions.get(pending.module);
        if (!fe) return;
        if (fe.status === "loading") return; // wait for the enumerate to land
        if (fe.status === "error") {
            setPendingXref(null);
            return;
        }

        // Ensure a module-wide index exists for this module before we can scan operands.
        if (analysis.builtModule() !== pending.module || analysis.status() === "idle") {
            if (analysis.status() !== "building") analysis.build(pending.module, fe.data);
            return; // building; re-runs when status flips to ready/error
        }
        if (analysis.status() === "building") return;
        if (analysis.status() === "error") {
            setPendingXref(null);
            return;
        }

        // Index ready: find referencing functions and jump to the first one, else fall back
        // to selecting whatever function contains the address itself.
        setPendingXref(null);
        const refs = functionsReferencingAddress(pending.address, analysis.disasmEntries());
        openAddress(refs.length > 0 ? refs[0] : pending.address);
    });

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

    // Fold each function into the xref index the moment its disassembly is viewed - free coverage
    // that accrues as the user browses, so "referenced by" fills in without an explicit build.
    createEffect(() => {
        const fn = selection.selectedFunction();
        if (!fn) return;
        const entry = disasm.get(fn.address);
        if (entry?.status !== "ready") return;
        xref.indexFunction(fn.address, nameOfFn(fn.module, fn.address), entry.data.results, modules.list());
    });

    // Decode every enumerated function of a module and fold its references into the index, so
    // incoming xrefs are comprehensive rather than only-what-you-browsed. Sequential and
    // cancellable; a new build (or a re-attach) supersedes any in-flight one via buildToken.
    async function buildIndex(module: string) {
        functions.ensure(module);
        const entry = functions.get(module);
        if (entry?.status !== "ready") return; // list not loaded yet; caller retries
        const list = entry.data;
        const token = ++buildToken;
        setBuildState({ running: true, done: 0, total: list.length });
        const mods = modules.list();
        for (let i = 0; i < list.length; i++) {
            if (token !== buildToken) return; // cancelled / superseded
            const fn = list[i];
            if (!xref.isIndexed(fn.address)) {
                try {
                    const res = await disassemble(client, { address: fn.address, size: fn.size });
                    if (token !== buildToken) return;
                    xref.indexFunction(fn.address, nameOfFn(module, fn.address), res.results, mods);
                } catch {
                    // A single undecodable function does not abort the whole build.
                }
            }
            setBuildState({ running: true, done: i + 1, total: list.length });
        }
        if (token === buildToken) setBuildState({ running: false, done: list.length, total: list.length });
    }

    function cancelBuild() {
        buildToken++;
        setBuildState((s) => ({ ...s, running: false }));
    }

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
                analysis.clear();
                selection.setSelectedFunction(null);
                selection.setPendingRva(null);
                selection.setPendingAddress(null);
                xref.clear();
                cancelBuild();
                setPendingXref(null);
            },
            { defer: true },
        ),
    );

    const xrefPending = () => pendingXref() !== null;

    return {
        functions,
        disasm,
        analysis,
        selection,
        xref,
        buildState,
        buildIndex,
        cancelBuild,
        selectModule,
        selectFunction,
        openPinned,
        openAddress,
        pivotAddressXref,
        xrefPending,
    };
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
