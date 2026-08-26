import { describe, expect, it } from "vitest";
import { gridKeyAction, rangeBetween, type GridKeyState } from "../nodes/gridKeys";

// The pure keyboard model: navigation clamping, range extension, paging, select-all, and the
// action keys. DOM guards (typing contexts) live in the component and are not modeled here.

const state = (over?: Partial<GridKeyState>): GridKeyState => ({
    rowCount: 10,
    focusIndex: 4,
    pageSize: 3,
    ...over,
});

const none = { shift: false, ctrlOrMeta: false };
const shift = { shift: true, ctrlOrMeta: false };
const ctrl = { shift: false, ctrlOrMeta: true };

describe("gridKeyAction navigation", () => {
    it("moves up/down and clamps at the edges", () => {
        expect(gridKeyAction("ArrowDown", none, state())).toEqual({ type: "focus", index: 5, extend: false });
        expect(gridKeyAction("ArrowUp", none, state())).toEqual({ type: "focus", index: 3, extend: false });
        expect(gridKeyAction("ArrowDown", none, state({ focusIndex: 9 }))).toEqual({ type: "focus", index: 9, extend: false });
        expect(gridKeyAction("ArrowUp", none, state({ focusIndex: 0 }))).toEqual({ type: "focus", index: 0, extend: false });
    });

    it("starts from the ends when nothing is focused", () => {
        expect(gridKeyAction("ArrowDown", none, state({ focusIndex: null }))).toEqual({ type: "focus", index: 0, extend: false });
        expect(gridKeyAction("ArrowUp", none, state({ focusIndex: null }))).toEqual({ type: "focus", index: 9, extend: false });
    });

    it("Home/End jump to the first/last visible row", () => {
        expect(gridKeyAction("Home", none, state())).toEqual({ type: "focus", index: 0, extend: false });
        expect(gridKeyAction("End", none, state())).toEqual({ type: "focus", index: 9, extend: false });
    });

    it("PageUp/PageDown move by the viewport size, clamped", () => {
        expect(gridKeyAction("PageDown", none, state())).toEqual({ type: "focus", index: 7, extend: false });
        expect(gridKeyAction("PageUp", none, state())).toEqual({ type: "focus", index: 1, extend: false });
        expect(gridKeyAction("PageDown", none, state({ focusIndex: 9 }))).toEqual({ type: "focus", index: 9, extend: false });
    });

    it("Shift marks the move as a range extension", () => {
        expect(gridKeyAction("ArrowDown", shift, state())).toEqual({ type: "focus", index: 5, extend: true });
        expect(gridKeyAction("End", shift, state())).toEqual({ type: "focus", index: 9, extend: true });
    });

    it("does nothing in an empty grid", () => {
        expect(gridKeyAction("ArrowDown", none, state({ rowCount: 0, focusIndex: null }))).toBeNull();
        expect(gridKeyAction("Home", none, state({ rowCount: 0 }))).toBeNull();
    });
});

describe("gridKeyAction commands", () => {
    it("Ctrl/Cmd+A selects all; a bare 'a' does not", () => {
        expect(gridKeyAction("a", ctrl, state())).toEqual({ type: "selectAll" });
        expect(gridKeyAction("A", ctrl, state())).toEqual({ type: "selectAll" });
        expect(gridKeyAction("a", none, state())).toBeNull();
    });

    it("Enter edits, F2 renames, Delete deletes - only with a focused row", () => {
        expect(gridKeyAction("Enter", none, state())).toEqual({ type: "edit" });
        expect(gridKeyAction("F2", none, state())).toEqual({ type: "rename" });
        expect(gridKeyAction("Delete", none, state())).toEqual({ type: "delete" });
        expect(gridKeyAction("Enter", none, state({ focusIndex: null }))).toBeNull();
        expect(gridKeyAction("F2", none, state({ focusIndex: null }))).toBeNull();
        expect(gridKeyAction("Delete", none, state({ focusIndex: null }))).toBeNull();
    });

    it("ContextMenu and Shift+F10 open the menu; bare F10 does not", () => {
        expect(gridKeyAction("ContextMenu", none, state())).toEqual({ type: "menu" });
        expect(gridKeyAction("F10", shift, state())).toEqual({ type: "menu" });
        expect(gridKeyAction("F10", none, state())).toBeNull();
    });

    it("Escape always maps to the escape action", () => {
        expect(gridKeyAction("Escape", none, state({ focusIndex: null }))).toEqual({ type: "escape" });
    });

    it("unhandled keys fall through", () => {
        expect(gridKeyAction("x", none, state())).toBeNull();
        expect(gridKeyAction("Tab", none, state())).toBeNull();
    });
});

describe("rangeBetween", () => {
    it("is inclusive and direction-agnostic", () => {
        expect(rangeBetween(2, 5)).toEqual([2, 3, 4, 5]);
        expect(rangeBetween(5, 2)).toEqual([2, 3, 4, 5]);
        expect(rangeBetween(3, 3)).toEqual([3]);
    });
});
