import { createStore, produce } from "solid-js/store";
import type { Instruction, ModuleEntry } from "../../../protocol/types";
import { parseHex, toHex } from "../../../state/address";
import { resolveLabel } from "../../../state/labels";

// Cross-reference extraction and index. We have no structured operands from the agent - only each
// instruction's rendered `text` - so targets are recovered by parsing that text: direct call/jmp
// immediates and rip-relative memory operands (resolved against the next instruction's address,
// the standard x86-64 rule). Only targets that land inside a known module range are kept; that
// filter drops stack offsets, tiny constants and other noise, leaving real code/data references.

export type XrefKind = "call" | "jmp" | "branch" | "data";

export interface XrefSite {
    /** Address of the referencing instruction. */
    from: string;
    /** Start address of the function the reference lives in. */
    fnAddr: string;
    fnName?: string;
    kind: XrefKind;
    /** The instruction text, for display. */
    text: string;
}

export interface XrefTarget {
    target: string;
    kind: XrefKind;
}

const CONTROL_FLOW = /^(call|jmp|loop|loopn?e|j[a-z]{1,3})$/i;
const RIP_REL = /\[rip\s*([+-])\s*(0x[0-9a-f]+)\]/i;
const BARE_ABS = /(?:^|[\s,])(0x[0-9a-f]{5,})\b/i; // 5+ hex digits: a real address, not a small const

function inModule(address: bigint, modules: readonly ModuleEntry[]): boolean {
    for (const m of modules) {
        const base = parseHex(m.base);
        if (address >= base && address < base + BigInt(m.size)) return true;
    }
    return false;
}

// Recover the reference target of a single instruction, or undefined when it references nothing
// that resolves inside a mapped module.
export function targetOf(instr: Instruction, modules: readonly ModuleEntry[]): XrefTarget | undefined {
    const text = instr.text.trim();
    const mnemonic = text.split(/\s+/, 1)[0] ?? "";

    // rip-relative data/code operand: target = next-instruction address ± disp.
    const rip = RIP_REL.exec(text);
    if (rip) {
        const disp = parseHex(rip[2]);
        const next = parseHex(instr.address) + BigInt(instr.length);
        const target = rip[1] === "-" ? next - disp : next + disp;
        if (inModule(target, modules)) {
            const kind: XrefKind = CONTROL_FLOW.test(mnemonic) ? "call" : "data";
            return { target: toHex(target), kind };
        }
        return undefined;
    }

    // direct control-flow immediate: call/jmp/jcc 0x...
    if (CONTROL_FLOW.test(mnemonic)) {
        const m = BARE_ABS.exec(text);
        if (m) {
            const target = parseHex(m[1]);
            if (inModule(target, modules)) {
                const kind: XrefKind = /^call/i.test(mnemonic) ? "call" : /^jmp/i.test(mnemonic) ? "jmp" : "branch";
                return { target: toHex(target), kind };
            }
        }
        return undefined;
    }

    // any other instruction carrying an absolute address that lands in a module (mov/lea globals).
    const abs = BARE_ABS.exec(text);
    if (abs) {
        const target = parseHex(abs[1]);
        if (inModule(target, modules)) return { target: toHex(target), kind: "data" };
    }
    return undefined;
}

// Outgoing references of a decoded function: every instruction whose target resolves in a module.
export interface OutgoingRef extends XrefTarget {
    from: string;
    label: string;
    text: string;
}

export function outgoingRefs(instructions: readonly Instruction[], modules: readonly ModuleEntry[]): OutgoingRef[] {
    const out: OutgoingRef[] = [];
    for (const instr of instructions) {
        const t = targetOf(instr, modules);
        if (t) out.push({ ...t, from: instr.address, label: resolveLabel(t.target, modules), text: instr.text.trim() });
    }
    return out;
}

// ---- index -----------------------------------------------------------------

interface XrefState {
    /** target address → sites that reference it. */
    byTarget: Record<string, XrefSite[]>;
    /** function start addresses already folded into the index (fetch-once guard). */
    indexed: Record<string, true>;
    functionsIndexed: number;
}

export function createXrefIndex() {
    const [store, setStore] = createStore<XrefState>({ byTarget: {}, indexed: {}, functionsIndexed: 0 });

    return {
        isIndexed(fnAddr: string): boolean {
            return store.indexed[fnAddr] === true;
        },
        refsTo(address: string): XrefSite[] {
            return store.byTarget[address] ?? [];
        },
        get functionsIndexed() {
            return store.functionsIndexed;
        },

        // Fold one decoded function's references into the index. Idempotent per function start.
        indexFunction(
            fnAddr: string,
            fnName: string | undefined,
            instructions: readonly Instruction[],
            modules: readonly ModuleEntry[],
        ) {
            if (store.indexed[fnAddr]) return;
            setStore(
                produce((s) => {
                    s.indexed[fnAddr] = true;
                    s.functionsIndexed++;
                    for (const instr of instructions) {
                        const t = targetOf(instr, modules);
                        if (!t) continue;
                        const site: XrefSite = { from: instr.address, fnAddr, fnName, kind: t.kind, text: instr.text.trim() };
                        const existing = s.byTarget[t.target];
                        if (!existing) {
                            s.byTarget[t.target] = [site];
                        } else if (!existing.some((e) => e.from === site.from)) {
                            existing.push(site);
                        }
                    }
                }),
            );
        },

        clear() {
            setStore({ byTarget: {}, indexed: {}, functionsIndexed: 0 });
        },
    };
}

export type XrefIndex = ReturnType<typeof createXrefIndex>;
