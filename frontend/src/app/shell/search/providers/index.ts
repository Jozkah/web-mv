import type { SearchProvider, SearchQuery } from "../types";
import { actionsProvider, themesProvider, viewsProvider } from "./commands";
import { targetsProvider, tabsProvider } from "./workspace";
import { modulesProvider } from "./modules";
import { addressesProvider } from "./addresses";
import { bookmarksProvider } from "./bookmarks";
import { memoryProvider } from "./memory";
import { functionsProvider } from "./functions";
import { historyProvider } from "./historyProvider";
import { cheatProvider } from "./cheat";
import { stringsProvider } from "./strings";
import { dataTypesProvider } from "./datatypes";
import { toolsProvider } from "./tools";

// The provider registry and query routing. Order here is only the tie-break fallback; ranking
// decides final placement. Routing narrows which providers run for a prefixed/scoped query so a
// `>`/`@`/`#` or `scope:` search hits just the relevant sources (and stays fast).

export const PROVIDERS: SearchProvider[] = [
    viewsProvider,
    actionsProvider,
    themesProvider,
    targetsProvider,
    tabsProvider,
    modulesProvider,
    addressesProvider,
    functionsProvider,
    bookmarksProvider,
    memoryProvider,
    cheatProvider,
    stringsProvider,
    dataTypesProvider,
    historyProvider,
    toolsProvider,
];

// Which providers should run for this query. A named scope or a prefix narrows the set; when
// neither is present (or the narrowing matches nothing) every provider runs so plain fuzzy search is
// never suppressed.
export function providersFor(query: SearchQuery, all: SearchProvider[] = PROVIDERS): SearchProvider[] {
    if (query.scope) {
        const scoped = all.filter((p) => p.scopes?.includes(query.scope!));
        if (scoped.length) return scoped;
    }
    if (query.prefix) {
        const byPrefix = all.filter((p) => p.prefix === query.prefix);
        if (byPrefix.length) return byPrefix;
    }
    return all;
}
