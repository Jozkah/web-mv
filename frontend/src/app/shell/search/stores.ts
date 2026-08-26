// Typed view of the app stores the providers read. Uses type-only imports of the context hooks so
// the search layer gets full typing without a runtime dependency on those modules (and never pulls
// in a view component). CommandPalette fills a PaletteStores at open time; providers cast the slice
// they use via `paletteStores(ctx)`.

import type { useApp } from "../../AppContext";
import type { useWorkspace } from "../../WorkspaceContext";
import type { useShell } from "../ShellContext";
import type { useMemory } from "../../../views/memory/state/MemoryContext";
import type { useStatic } from "../../../views/static/state/StaticContext";
import type { useStrings } from "../../../views/strings/state/StringsContext";
import type { useSigMaker } from "../../../views/static/sigmaker/SigMakerContext";
import type { useSessionActions } from "../sessionActions";
import type { SearchContext } from "./types";

export interface PaletteStores {
    app: ReturnType<typeof useApp>;
    ws: ReturnType<typeof useWorkspace>;
    shell: ReturnType<typeof useShell>;
    memory: ReturnType<typeof useMemory>;
    staticCtx: ReturnType<typeof useStatic>;
    strings: ReturnType<typeof useStrings>;
    sigMaker: ReturnType<typeof useSigMaker>;
    session: ReturnType<typeof useSessionActions>;
}

export function paletteStores(ctx: SearchContext): PaletteStores {
    return ctx.stores as unknown as PaletteStores;
}
