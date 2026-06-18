import { createSignal } from "solid-js";
import type { AxClient } from "../transport/AxClient";
import type { ModuleEntry } from "../protocol/types";
import { modules as modulesRequest } from "../protocol/requests";
import { errorText } from "./errors";

// The attached process's module list. Fetched once when the agent attaches (and on an
// explicit refresh) rather than polled - the list rarely changes and a steady poll just
// churns every memo that reads a module base. Promoted to shared state because more
// than one concern needs it: the modules panel renders it, and anything computing an RVA
// needs a module's base.

export type ModulesStatus = "idle" | "loading" | "ready" | "error";

// Case-insensitive substring match on module name, shared by the modules panel and the scan
// card's module picker so "search modules" means the same thing in both. An empty query (after
// trimming) returns the list untouched.
export function filterModules(list: readonly ModuleEntry[], query: string): readonly ModuleEntry[] {
    const q = query.trim().toLowerCase();
    return q ? list.filter((m) => m.name.toLowerCase().includes(q)) : list;
}

export function createModulesStore(client: AxClient) {
    const [list, setList] = createSignal<ModuleEntry[]>([]);
    const [status, setStatus] = createSignal<ModulesStatus>("idle");
    const [error, setError] = createSignal<string>();

    const baseOf = (name: string): string | undefined =>
        list().find((m) => m.name === name)?.base;

    const load = async () => {
        setStatus("loading");
        setError(undefined);
        try {
            const res = await modulesRequest(client);
            setList(res.modules);
            setStatus("ready");
        } catch (e) {
            setStatus("error");
            setError(errorText(e));
        }
    };

    const clear = () => {
        setList([]);
        setStatus("idle");
        setError(undefined);
    };

    return { list, status, error, baseOf, load, clear };
}

export type ModulesStore = ReturnType<typeof createModulesStore>;
