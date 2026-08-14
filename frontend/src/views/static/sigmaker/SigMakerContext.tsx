import { type JSX, Show, createContext, createSignal, useContext } from "solid-js";
import type { Instruction } from "../../../protocol/types";
import { SigMakerModal } from "../components/SigMakerModal";

// Describes what to seed the SigMaker modal with. Everything is optional: an empty target opens
// the modal with a blank address input the user fills in. A function launch supplies module +
// address + size (and optionally already-disassembled instructions to skip a re-fetch); a memory
// / data launch supplies an address and source "raw".
export interface SigMakerTarget {
    moduleName?: string;
    functionName?: string;
    address?: string;
    size?: number;
    source?: "code" | "raw";
    instructions?: Instruction[];
}

interface SigMakerApi {
    open: (target?: SigMakerTarget) => void;
    close: () => void;
    target: () => SigMakerTarget | null;
}

const SigMakerCtx = createContext<SigMakerApi>();

// App-level host: mounts the SigMaker modal once and exposes open/close so any view (top bar,
// disassembly, function list, memory) can launch it without owning its own modal state.
export function SigMakerProvider(props: { children: JSX.Element }) {
    const [target, setTarget] = createSignal<SigMakerTarget | null>(null);

    const api: SigMakerApi = {
        open: (t = {}) => setTarget(t),
        close: () => setTarget(null),
        target,
    };

    return (
        <SigMakerCtx.Provider value={api}>
            {props.children}
            <Show when={target()} keyed>
                {(t) => <SigMakerModal target={t} onClose={api.close} />}
            </Show>
        </SigMakerCtx.Provider>
    );
}

export function useSigMaker(): SigMakerApi {
    const ctx = useContext(SigMakerCtx);
    if (!ctx) throw new Error("useSigMaker must be used within a SigMakerProvider");
    return ctx;
}
