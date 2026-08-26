// Clipboard text builders for the node context menu's "Copy" submenu. Pure string shaping over a
// small context struct so the menu wiring stays declarative and each format is easy to eyeball.
// The three raw formats (address / value / bytes) are computed by the caller from the live
// snapshot; the three derived ones (pointer-path / offsetof / ReClass) are built here from the
// class + node layout, which is all static.

import { nodeType, isStringType, type Node } from "./types";

export type CopyFormat = "address" | "value" | "bytes" | "pointer-path" | "offsetof" | "reclass";

export interface CopyContext {
    className: string;
    node: Node;
    offset: number;
    byteSize: number;
    /** Absolute address of the field, canonical hex ("0x..."), or "" when the class has no base. */
    address: string;
    /** Class base address, canonical hex, or "" - the root of the pointer path. */
    baseAddress: string;
    /** Live decoded value, or undefined when there's no snapshot in bounds. */
    value?: string;
    /** Live field bytes as spaced hex ("48 8B .."), or undefined when out of bounds. */
    bytes?: string;
}

/** A field's display name: its user name, else an offset-based placeholder ("field_1c"). */
function fieldName(ctx: CopyContext): string {
    return ctx.node.name ?? `field_${ctx.offset.toString(16)}`;
}

const FLOAT_COUNTS: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4, mat4: 16 };

/** A C-ish member declaration for the field, arrays spelled out for strings ("char name[16]")
 *  and float vectors/matrices; registry refs use their referenced type name. */
function memberDecl(ctx: CopyContext): string {
    const id = ctx.node.typeId;
    const label = nodeType(id).label;
    const name = fieldName(ctx);
    const at = `//0x${ctx.offset.toString(16).padStart(4, "0")}`;
    if (isStringType(id)) {
        const elem = id === "wstring" ? "wchar_t" : "char";
        const count = id === "wstring" ? ctx.byteSize >> 1 : ctx.byteSize;
        return `${elem} ${name}[${count}]; ${at} (${label})`;
    }
    if (id in FLOAT_COUNTS) return `float ${name}[${FLOAT_COUNTS[id]}]; ${at} (${label})`;
    if (id === "enumref" || id === "structref") {
        return `${ctx.node.refName ?? "Unknown"} ${name}; ${at} (${label}, 0x${ctx.byteSize.toString(16)} bytes)`;
    }
    if (id === "funcptr") return `uintptr_t ${name}; ${at} (fn ptr)`;
    return `${label} ${name}; ${at}`;
}

/** Build the clipboard text for one format, or undefined when the data it needs isn't available
 *  (e.g. copying a live value with no snapshot, or an address with no class base). */
export function buildCopyText(format: CopyFormat, ctx: CopyContext): string | undefined {
    const offHex = ctx.offset.toString(16);
    switch (format) {
        case "address":
            return ctx.address || undefined;
        case "value":
            return ctx.value;
        case "bytes":
            return ctx.bytes;
        case "pointer-path":
            // CE/ReClass-style dereference chain from the class base to this field's slot.
            return ctx.baseAddress ? `[${ctx.baseAddress}+0x${offHex}]` : undefined;
        case "offsetof":
            return `offsetof(${ctx.className}, ${fieldName(ctx)}) // 0x${offHex}`;
        case "reclass":
            return memberDecl(ctx);
    }
}
