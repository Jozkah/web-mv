import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import type { Instruction } from "../../../../protocol/types";
import { parseHex } from "../../../../state/address";

// CodeMirror configuration for the read-only disassembly view. A lightweight x86 tokenizer
// (no full grammar - this is a dump, not an editor) gives the address / mnemonic /
// register / immediate coloring you expect from a disassembler.

interface AsmState {
    afterAddr: boolean;
    sawMnemonic: boolean;
}

// Common x86-64 registers (incl. r8d/r15w/xmm0 style and segment regs).
const REGISTER =
    /^(?:r(?:ax|bx|cx|dx|si|di|bp|sp|ip|8|9|1[0-5])[dwb]?|e(?:ax|bx|cx|dx|si|di|bp|sp|ip)|[abcd]x|[abcd][lh]|sil|dil|bpl|spl|si|di|bp|sp|[cdefgs]s|x?mm\d+|ymm\d+)\b/i;
const SIZE_KEYWORD = /^(?:byte|word|dword|qword|tbyte|xmmword|ymmword|ptr)\b/i;

const asmLanguage = StreamLanguage.define<AsmState>({
    startState: () => ({ afterAddr: false, sawMnemonic: false }),
    token(stream, state) {
        if (stream.sol()) {
            state.afterAddr = false;
            state.sawMnemonic = false;
        }
        if (stream.eatSpace()) return null;
        if (stream.match(/^;.*/)) return "comment";

        // First hex token on a line is the address column.
        if (!state.afterAddr && stream.match(/^0x[0-9a-f]+/i)) {
            state.afterAddr = true;
            return "number";
        }
        if (stream.match(/^0x[0-9a-f]+/i) || stream.match(/^\d+\b/)) return "number";
        if (stream.match(SIZE_KEYWORD)) return "atom";
        if (stream.match(REGISTER)) return "variable";

        // First word after the address is the mnemonic.
        if (!state.sawMnemonic && stream.match(/^[a-z][a-z0-9]*/i)) {
            state.sawMnemonic = true;
            return "keyword";
        }
        if (stream.match(/^[a-z_.][a-z0-9_.]*/i)) return null;

        stream.next();
        return null;
    },
});

const highlightStyle = HighlightStyle.define([
    { tag: t.keyword, color: "var(--accent)", fontWeight: "600" }, // mnemonic
    { tag: t.number, color: "#3b82f6" }, // address column + immediates
    { tag: t.variableName, color: "#16a34a" }, // registers ("variable" token → variableName tag)
    { tag: t.atom, color: "var(--text)" }, // byte/word/ptr size keywords
    { tag: t.comment, color: "var(--text)", fontStyle: "italic" },
]);

const theme = EditorView.theme({
    "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent" },
    ".cm-content": { fontFamily: "var(--mono)" },
    ".cm-gutters": { backgroundColor: "transparent", border: "none" },
    "&.cm-focused": { outline: "none" },
    ".cm-operand-label": { color: "var(--text)", opacity: "0.5", fontStyle: "italic", marginLeft: "1.5ch" },
    ".cm-operand-label.nav": { cursor: "pointer" },
    ".cm-operand-label.nav:hover": { opacity: "0.9", textDecoration: "underline" },
});

// A resolved operand annotation for one instruction line: the display text (a function name or
// `module+0xRVA`) and the absolute target it points at, so a click can navigate there.
export interface OperandLabel {
    text: string;
    target: string;
    /** True when the target lands in a mapped module (a real code/data ref worth a click). */
    navigable: boolean;
}

type LabelClick = (target: string, text: string) => void;

// End-of-line widget rendering an operand annotation, e.g. `  ; sub_1a3f` or `  ; game.dll+0x28`.
class LabelWidget extends WidgetType {
    private readonly label: OperandLabel;
    private readonly onClick: LabelClick;
    constructor(label: OperandLabel, onClick: LabelClick) {
        super();
        this.label = label;
        this.onClick = onClick;
    }
    override eq(other: LabelWidget): boolean {
        return other.label.text === this.label.text && other.label.target === this.label.target;
    }
    override toDOM(): HTMLElement {
        const span = document.createElement("span");
        span.className = this.label.navigable ? "cm-operand-label nav" : "cm-operand-label";
        span.textContent = `; ${this.label.text}`;
        if (this.label.navigable) {
            span.title = `go to ${this.label.target}`;
            span.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.onClick(this.label.target, this.label.text);
            });
        }
        return span;
    }
    override ignoreEvent(): boolean {
        return true;
    }
}

// Labels are pushed as an effect (one entry per instruction line, null for lines with no
// reference) and materialised into end-of-line widget decorations.
const setLabels = StateEffect.define<(OperandLabel | null)[]>();

function buildLabelDecorations(state: EditorState, labels: (OperandLabel | null)[], onClick: LabelClick): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const lineCount = state.doc.lines;
    for (let i = 0; i < labels.length && i < lineCount; i++) {
        const label = labels[i];
        if (!label) continue;
        const line = state.doc.line(i + 1);
        builder.add(line.to, line.to, Decoration.widget({ widget: new LabelWidget(label, onClick), side: 1 }));
    }
    return builder.finish();
}

function labelField(onClick: LabelClick): StateField<DecorationSet> {
    return StateField.define<DecorationSet>({
        create: () => Decoration.none,
        update(deco, tr) {
            for (const e of tr.effects) if (e.is(setLabels)) return buildLabelDecorations(tr.state, e.value, onClick);
            return tr.docChanged ? deco.map(tr.changes) : deco;
        },
        provide: (f) => EditorView.decorations.from(f),
    });
}

function makeExtensions(onLabelClick: LabelClick) {
    return [
        asmLanguage,
        syntaxHighlighting(highlightStyle),
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        theme,
        labelField(onLabelClick),
    ];
}

/** One instruction per line: `<address>  <disassembly text>`. */
export function buildDoc(instructions: Instruction[]): string {
    return instructions.map((i) => `${i.address}  ${i.text}`).join("\n");
}

// Flow-terminating instructions that mark the natural end of a function: a return or an
// unconditional tail-call jmp (conditional jcc are not terminators and are excluded).
const TERMINATOR = /^(?:ret[nf]?|iret[dq]?|jmp)\b/i;

// Whether the disassembly actually covers the whole function. The agent's own `complete`
// flag is unreliable: a function's enumerated `size` usually includes trailing alignment
// padding (int3/nop) that the agent never decodes, so "decoded fewer bytes than size" is a
// false truncation signal. We instead call it complete when the last instruction either
// reaches the end of the range or is a flow terminator; only a body that stops short on a
// non-terminator (agent cap, undecodable byte) is genuinely truncated.
export function isComplete(address: string, size: number, instructions: Instruction[]): boolean {
    if (instructions.length === 0) return false;
    const last = instructions[instructions.length - 1];
    const end = parseHex(last.address) + BigInt(last.length);
    if (end >= parseHex(address) + BigInt(size)) return true;
    return TERMINATOR.test(last.text.trimStart());
}

export function createEditor(
    parent: HTMLElement,
    doc: string,
    labels: (OperandLabel | null)[],
    onLabelClick: LabelClick,
): EditorView {
    const view = new EditorView({ doc, extensions: makeExtensions(onLabelClick), parent });
    view.dispatch({ effects: setLabels.of(labels) });
    return view;
}

/** Replace the whole document and its operand labels in one transaction (function changed). */
export function setContent(view: EditorView, doc: string, labels: (OperandLabel | null)[]): void {
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        effects: setLabels.of(labels),
    });
}
