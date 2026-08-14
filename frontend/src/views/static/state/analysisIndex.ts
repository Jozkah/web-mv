import { createSignal } from "solid-js";
import type { AxClient } from "../../../transport/AxClient";
import { disassemble } from "../../../protocol/requests";
import type { FunctionEntry, Instruction } from "../../../protocol/types";
import { errorText } from "../../../state/errors";
import { buildXrefIndex, sortedFunctions, type XrefIndex } from "./analysisXref";

// A whole-module analysis index: the disassembly of every enumerated function plus the
// call/xref graph built from it. Unlike the per-function disasm cache this is expensive
// (one decode request per function), so it is user-triggered - like the strings scan - and
// runs one module at a time with progress and cancellation. The callers list, cross-function
// pivots and module-wide operand search all read from what it produces.

export type IndexStatus = "idle" | "building" | "ready" | "error";

// How many disassemble requests we keep in flight. Bounded so a huge module does not open
// thousands of concurrent socket requests at once.
const CONCURRENCY = 8;

export function createAnalysisIndex(client: AxClient) {
    const [builtModule, setBuiltModule] = createSignal<string | null>(null);
    const [status, setStatus] = createSignal<IndexStatus>("idle");
    const [error, setError] = createSignal<string | null>(null);
    const [done, setDone] = createSignal(0);
    const [total, setTotal] = createSignal(0);

    // Non-reactive result payloads: replaced wholesale when a build finishes, read via the
    // reactive `status`/`builtModule` gate so consumers re-run only on completion.
    let disasmMap = new Map<string, Instruction[]>();
    let sorted: FunctionEntry[] = [];
    let xref: XrefIndex | undefined;

    // Monotonic token so a stale/cancelled build cannot overwrite a newer one's results.
    let runToken = 0;

    async function build(module: string, functions: FunctionEntry[]) {
        const token = ++runToken;
        setBuiltModule(module);
        setStatus("building");
        setError(null);
        setDone(0);
        setTotal(functions.length);

        const nextMap = new Map<string, Instruction[]>();
        let cursor = 0;

        const worker = async () => {
            while (cursor < functions.length) {
                if (token !== runToken) return; // cancelled or superseded
                const fn = functions[cursor++];
                try {
                    const res = await disassemble(client, { address: fn.address, size: fn.size });
                    nextMap.set(fn.address, res.results);
                } catch {
                    // A single function failing to decode should not sink the whole index;
                    // it simply contributes no edges.
                    nextMap.set(fn.address, []);
                }
                if (token === runToken) setDone((d) => d + 1);
            }
        };

        try {
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, functions.length) }, worker));
            if (token !== runToken) return; // a newer build started; drop these results

            disasmMap = nextMap;
            sorted = sortedFunctions(functions);
            xref = buildXrefIndex(functions, nextMap);
            setStatus("ready");
        } catch (e) {
            if (token !== runToken) return;
            setStatus("error");
            setError(errorText(e));
        }
    }

    function cancel() {
        if (status() !== "building") return;
        runToken++; // orphan the running workers
        setStatus("idle");
    }

    function clear() {
        runToken++;
        disasmMap = new Map();
        sorted = [];
        xref = undefined;
        setBuiltModule(null);
        setStatus("idle");
        setError(null);
        setDone(0);
        setTotal(0);
    }

    return {
        builtModule,
        status,
        error,
        done,
        total,
        // Reading the result accessors while status()==="ready" is what makes a consumer
        // reactive: they touch status()/builtModule() and re-read on completion.
        index: (): XrefIndex | undefined => (status() === "ready" ? xref : undefined),
        disasmOf: (address: string): Instruction[] | undefined =>
            status() === "ready" ? disasmMap.get(address) : undefined,
        disasmEntries: (): Array<[string, Instruction[]]> =>
            status() === "ready" ? [...disasmMap.entries()] : [],
        sortedFns: (): FunctionEntry[] => (status() === "ready" ? sorted : []),
        build,
        cancel,
        clear,
    };
}

export type AnalysisIndex = ReturnType<typeof createAnalysisIndex>;
