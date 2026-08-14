import type { FunctionEntry, Instruction } from "../../../protocol/types";
import { parseHex } from "../../../state/address";

// Client-side disassembly analysis. The agent only hands us raw instructions
// ({address,length,bytes,text}); everything structural - branch targets, basic blocks,
// call/xref graph, prototype guesses - is parsed out of the `text` string here. Kept as
// pure functions so the views and the module-index builder can share them.

// First whitespace-delimited token of an instruction is its mnemonic.
export function mnemonicOf(text: string): string {
    const m = text.trimStart().match(/^[a-z][a-z0-9]*/i);
    return m ? m[0].toLowerCase() : "";
}

const CALL_RE = /^call/i;
const RET_RE = /^(?:ret[nf]?|iret[dq]?)$/i;
const UNCOND_JMP_RE = /^jmp$/i;
// Conditional jumps: jcc family (je/jne/jz/jg/jle/jae/...), loop, jecxz/jrcxz.
const COND_JMP_RE = /^(?:j(?:[abgls]e?|n[abgls]e?|[czps]|n[czps]|o|no|p[eo]|cxz|ecxz|rcxz)|loop(?:e|ne|z|nz)?)$/i;

export function isCall(text: string): boolean {
    return CALL_RE.test(mnemonicOf(text));
}
export function isReturn(text: string): boolean {
    return RET_RE.test(mnemonicOf(text));
}
export function isUncondJump(text: string): boolean {
    return UNCOND_JMP_RE.test(mnemonicOf(text));
}
export function isCondJump(text: string): boolean {
    return COND_JMP_RE.test(mnemonicOf(text));
}
export function isBranch(text: string): boolean {
    return isUncondJump(text) || isCondJump(text);
}
/** Any instruction that ends a basic block: branch, ret or call. */
export function isBlockTerminator(text: string): boolean {
    return isBranch(text) || isReturn(text) || isCall(text);
}

// The operand portion of an instruction (everything after the mnemonic).
function operandsOf(text: string): string {
    const t = text.trimStart();
    const sp = t.indexOf(" ");
    return sp < 0 ? "" : t.slice(sp + 1).trim();
}

// A direct branch/call target is the (single) absolute hex address in the operand of a
// control-flow instruction, e.g. `call 0x7ff6abcd1234` / `jne 0x140001b30`. Register or
// memory-indirect targets (`call rax`, `jmp qword ptr [rip+0x..]`) have no static target.
export function targetOf(text: string): string | null {
    if (!isCall(text) && !isBranch(text)) return null;
    const m = operandsOf(text).match(/0x[0-9a-f]+/i);
    return m ? m[0].toLowerCase() : null;
}

// Every immediate/displacement literal appearing in an instruction's operands, normalised
// to canonical lowercase hex. Used by the operand value search. Bare decimal literals are
// converted to hex so a single query matches either notation.
export function immediatesOf(text: string): string[] {
    const ops = operandsOf(text);
    const out: string[] = [];
    for (const tok of ops.matchAll(/0x[0-9a-f]+|\b\d+\b/gi)) {
        const raw = tok[0];
        try {
            // BigInt() reads both "0x.." and bare decimal, giving one canonical hex form.
            out.push(`0x${BigInt(raw).toString(16)}`);
        } catch {
            /* not a valid literal - skip */
        }
    }
    return out;
}

// ---- Basic blocks -----------------------------------------------------------------------

export interface BasicBlock {
    id: number;
    start: string; // address of the first instruction
    instructions: Instruction[];
    successors: number[]; // block ids reachable from the terminator
}

// Split a function's linear instruction stream into basic blocks. Leaders are: the entry,
// any in-function branch target, and the instruction following any branch/jmp/ret/call.
export function splitBasicBlocks(instructions: Instruction[]): BasicBlock[] {
    if (instructions.length === 0) return [];

    const addrIndex = new Map<string, number>();
    instructions.forEach((ins, i) => addrIndex.set(ins.address, i));

    const leaders = new Set<number>([0]);
    instructions.forEach((ins, i) => {
        if (isBlockTerminator(ins.text)) {
            if (i + 1 < instructions.length) leaders.add(i + 1); // fallthrough
            const tgt = targetOf(ins.text);
            if (tgt) {
                const ti = addrIndex.get(tgt);
                if (ti !== undefined) leaders.add(ti); // in-function branch target
            }
        }
    });

    const sortedLeaders = [...leaders].sort((a, b) => a - b);
    const blockOfLeader = new Map<number, number>();
    sortedLeaders.forEach((idx, blockId) => blockOfLeader.set(idx, blockId));

    const blocks: BasicBlock[] = [];
    for (let b = 0; b < sortedLeaders.length; b++) {
        const from = sortedLeaders[b];
        const to = b + 1 < sortedLeaders.length ? sortedLeaders[b + 1] : instructions.length;
        const slice = instructions.slice(from, to);
        blocks.push({ id: b, start: slice[0].address, instructions: slice, successors: [] });
    }

    // Wire successors from each block's terminating instruction.
    for (const block of blocks) {
        const last = block.instructions[block.instructions.length - 1];
        const fallthroughIdx = addrIndex.get(last.address)! + 1;
        const fallthroughBlock =
            fallthroughIdx < instructions.length ? blockOfLeader.get(fallthroughIdx) : undefined;
        const tgt = targetOf(last.text);
        const targetBlock = tgt !== null ? blockOfLeader.get(addrIndex.get(tgt) ?? -1) : undefined;

        const succ: number[] = [];
        if (isReturn(last.text)) {
            // no successors
        } else if (isUncondJump(last.text)) {
            if (targetBlock !== undefined) succ.push(targetBlock);
        } else if (isCondJump(last.text)) {
            if (targetBlock !== undefined) succ.push(targetBlock);
            if (fallthroughBlock !== undefined) succ.push(fallthroughBlock);
        } else {
            // call or a normal instruction that happened to end the block: falls through
            if (fallthroughBlock !== undefined) succ.push(fallthroughBlock);
        }
        block.successors = [...new Set(succ)];
    }

    return blocks;
}

// ---- Containing-function lookup ---------------------------------------------------------

/** Functions sorted by address so a hit address can be resolved to its owner in O(log n). */
export function sortedFunctions(functions: FunctionEntry[]): FunctionEntry[] {
    return [...functions].sort((a, b) => {
        const x = parseHex(a.address);
        const y = parseHex(b.address);
        return x < y ? -1 : x > y ? 1 : 0;
    });
}

// Function whose [address, address+size) range contains `address`, or undefined. Expects
// the sorted list from sortedFunctions().
export function functionContaining(
    sorted: FunctionEntry[],
    address: string,
): FunctionEntry | undefined {
    const target = parseHex(address);
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const start = parseHex(sorted[mid].address);
        if (target < start) hi = mid - 1;
        else if (target >= start + BigInt(sorted[mid].size)) lo = mid + 1;
        else return sorted[mid];
    }
    return undefined;
}

// ---- Whole-module call/xref index -------------------------------------------------------

export interface XrefIndex {
    // caller function address -> set of callee function addresses it references.
    outgoing: Map<string, Set<string>>;
    // callee function address -> set of caller function addresses that reference it.
    incoming: Map<string, Set<string>>;
    // raw target address -> set of caller function addresses (for arbitrary-address xrefs,
    // e.g. a string/data address referenced by rip-relative literals in call/branch ops).
    targetCallers: Map<string, Set<string>>;
}

// Build the module xref graph from a map of function-entry-address -> decoded instructions.
// Only direct (statically resolvable) call/branch targets participate; indirect calls are
// invisible to a static pass and are simply skipped.
export function buildXrefIndex(
    functions: FunctionEntry[],
    disasmByAddress: Map<string, Instruction[]>,
): XrefIndex {
    const sorted = sortedFunctions(functions);
    const outgoing = new Map<string, Set<string>>();
    const incoming = new Map<string, Set<string>>();
    const targetCallers = new Map<string, Set<string>>();

    const addTo = (map: Map<string, Set<string>>, key: string, value: string) => {
        let set = map.get(key);
        if (!set) map.set(key, (set = new Set()));
        set.add(value);
    };

    for (const fn of functions) {
        const instrs = disasmByAddress.get(fn.address);
        if (!instrs) continue;
        for (const ins of instrs) {
            const tgt = targetOf(ins.text);
            if (!tgt) continue;
            addTo(targetCallers, tgt, fn.address);
            const owner = functionContaining(sorted, tgt);
            if (owner && owner.address !== fn.address) {
                addTo(outgoing, fn.address, owner.address);
                addTo(incoming, owner.address, fn.address);
            }
        }
    }

    return { outgoing, incoming, targetCallers };
}

// Direct callees of a single function, resolved to owning-function addresses, straight from
// its own disassembly (no whole-module index needed). Self-recursive calls are dropped.
export function calleesOf(
    fnAddress: string,
    instructions: Instruction[],
    sorted: FunctionEntry[],
): string[] {
    const out = new Set<string>();
    for (const ins of instructions) {
        const tgt = targetOf(ins.text);
        if (!tgt) continue;
        const owner = functionContaining(sorted, tgt);
        if (owner && owner.address !== fnAddress) out.add(owner.address);
    }
    return [...out];
}

// Functions whose disassembly references an arbitrary absolute address (e.g. a string or
// data pointer) anywhere in an operand. Unlike the call/branch xref this scans the full
// operand text, since string references come from lea/mov rip-relative operands the agent
// renders as the resolved absolute address. Returns owning-function addresses, unique.
export function functionsReferencingAddress(
    address: string,
    disasmEntries: Array<[string, Instruction[]]>,
): string[] {
    const needle = address.toLowerCase();
    const out = new Set<string>();
    for (const [fnAddress, instrs] of disasmEntries) {
        for (const ins of instrs) {
            if (ins.text.toLowerCase().includes(needle)) {
                out.add(fnAddress);
                break;
            }
        }
    }
    return [...out];
}

// ---- Prototype inference ----------------------------------------------------------------

export interface InferredPrototype {
    returnType: string; // "void" | "int64_t" (rax written) - a coarse guess
    intArgs: number; // count of leading integer arg slots (rcx,rdx,r8,r9) used as inputs
    floatArgs: number; // count of leading xmm slots (xmm0..xmm3) used as inputs
    frameSize: number; // bytes reserved by `sub rsp, N` in the prologue, if any
    signature: string; // rendered `ret name(args)` string
}

// Integer arg registers in MS x64 order, each with the sub-register spellings we must catch.
const INT_ARGS: Array<{ slot: string; re: RegExp }> = [
    { slot: "rcx", re: /\b(?:rcx|ecx|cx|cl|ch)\b/i },
    { slot: "rdx", re: /\b(?:rdx|edx|dx|dl|dh)\b/i },
    { slot: "r8", re: /\b(?:r8[dwb]?)\b/i },
    { slot: "r9", re: /\b(?:r9[dwb]?)\b/i },
];
const FLOAT_ARGS: RegExp[] = [/\bxmm0\b/i, /\bxmm1\b/i, /\bxmm2\b/i, /\bxmm3\b/i];

// Mnemonics that write their first operand without reading it. If an arg register's first
// appearance is as the destination of one of these, it was set by the callee, not passed in.
const WRITE_FIRST = /^(?:mov|movzx|movsx|movsxd|lea|movabs|movss|movsd|movaps|movups|movdqa|movdqu|xorps|pxor)$/i;

// Whether `re` matches inside the first operand only (the destination lane).
function matchesDestOnly(text: string, re: RegExp): boolean {
    const ops = operandsOf(text);
    const comma = ops.indexOf(",");
    const dest = comma < 0 ? ops : ops.slice(0, comma);
    const rest = comma < 0 ? "" : ops.slice(comma + 1);
    // A memory destination `[... reg ...]` reads the register, so that still counts as a use.
    const destIsMem = /\[/.test(dest);
    return re.test(dest) && !destIsMem && !re.test(rest);
}

// Does the function read register-family `re` before it ever writes it? That is the signal
// that the value came in as an argument rather than being produced locally.
function readBeforeWrite(instructions: Instruction[], re: RegExp): boolean {
    for (const ins of instructions) {
        if (!re.test(ins.text)) continue; // first mention of this register family
        // Written first (dest of a write-first mnemonic, register dest) -> not an argument.
        if (WRITE_FIRST.test(mnemonicOf(ins.text)) && matchesDestOnly(ins.text, re)) return false;
        return true; // any other first use reads it
    }
    return false;
}

function framePrologue(instructions: Instruction[]): number {
    // Look at the first handful of instructions for `sub rsp, 0xN`.
    for (const ins of instructions.slice(0, 8)) {
        const m = ins.text.match(/^\s*sub\s+rsp\s*,\s*(0x[0-9a-f]+|\d+)/i);
        if (m) {
            try {
                return Number(BigInt(m[1]));
            } catch {
                return 0;
            }
        }
    }
    return 0;
}

export function inferPrototype(name: string, instructions: Instruction[]): InferredPrototype {
    let intArgs = 0;
    for (const arg of INT_ARGS) {
        if (readBeforeWrite(instructions, arg.re)) intArgs++;
        else break; // arg slots fill left-to-right; stop at the first unused one
    }
    let floatArgs = 0;
    for (const re of FLOAT_ARGS) {
        if (readBeforeWrite(instructions, re)) floatArgs++;
        else break;
    }

    // rax written anywhere -> assume a return value. Pure-void functions never touch rax/eax.
    const writesRax = instructions.some(
        (ins) => WRITE_FIRST.test(mnemonicOf(ins.text)) && matchesDestOnly(ins.text, /\b(?:rax|eax|al|ax)\b/i),
    );
    const returnType = writesRax ? "int64_t" : "void";
    const frameSize = framePrologue(instructions);

    const params: string[] = [];
    for (let i = 0; i < intArgs; i++) params.push(`int64_t a${params.length + 1}`);
    for (let i = 0; i < floatArgs; i++) params.push(`double f${i + 1}`);
    const signature = `${returnType} ${name}(${params.length ? params.join(", ") : "void"})`;

    return { returnType, intArgs, floatArgs, frameSize, signature };
}

// ---- Function-boundary statistics -------------------------------------------------------

export interface FunctionStats {
    count: number;
    sized: number; // functions with a known non-zero size
    unsized: number; // functions the agent reported with size 0
    totalBytes: number; // sum of sizes
    spanBytes: number; // last function end - first function start
    coverage: number; // totalBytes / spanBytes, 0..1
    gapCount: number; // number of inter-function gaps (unanalysed regions)
    gapBytes: number; // total bytes not covered by any function within the span
    largest: FunctionEntry | undefined;
}

// Summarise a module's enumerated functions: how many, how much of the code span they
// actually cover, and the size of the gaps between them (candidate un-analysed code).
export function computeFunctionStats(functions: FunctionEntry[]): FunctionStats {
    const count = functions.length;
    if (count === 0) {
        return {
            count: 0,
            sized: 0,
            unsized: 0,
            totalBytes: 0,
            spanBytes: 0,
            coverage: 0,
            gapCount: 0,
            gapBytes: 0,
            largest: undefined,
        };
    }

    const sorted = sortedFunctions(functions);
    let sized = 0;
    let totalBytes = 0;
    let largest = sorted[0];
    for (const fn of sorted) {
        if (fn.size > 0) sized++;
        totalBytes += fn.size;
        if (fn.size > largest.size) largest = fn;
    }

    const firstStart = parseHex(sorted[0].address);
    let lastEnd = firstStart;
    for (const fn of sorted) {
        const end = parseHex(fn.address) + BigInt(fn.size);
        if (end > lastEnd) lastEnd = end;
    }
    const spanBytes = Number(lastEnd - firstStart);

    // Walk the sorted list tracking the running end; any forward jump is a gap.
    let gapCount = 0;
    let gapBytes = 0;
    let cursor = firstStart;
    for (const fn of sorted) {
        const start = parseHex(fn.address);
        if (start > cursor) {
            gapCount++;
            gapBytes += Number(start - cursor);
        }
        const end = parseHex(fn.address) + BigInt(fn.size);
        if (end > cursor) cursor = end;
    }

    return {
        count,
        sized,
        unsized: count - sized,
        totalBytes,
        spanBytes,
        coverage: spanBytes > 0 ? totalBytes / spanBytes : 0,
        gapCount,
        gapBytes,
        largest,
    };
}
