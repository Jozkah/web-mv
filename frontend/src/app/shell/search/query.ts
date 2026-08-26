import { SCOPES, SEARCH_GROUPS, type ScopeName, type SearchGroup, type SearchQuery, type Prefix } from "./types";

// Query parsing. Turns raw omnibox text into a structured SearchQuery: an optional leading prefix
// (`>` `@` `#`), an optional named scope (`module:`, `bookmark:` …), a `group:` filter, quoted
// phrases, negative `-terms`, and the residual free-text tokens providers rank against. Structured
// syntax is best-effort — a malformed `group:` reports an error but the rest still parses so plain
// fuzzy search never breaks (spec §4).

const SCOPE_SET = new Set<string>(SCOPES);
const PREFIXES: Prefix[] = [">", "@", "#"];

interface RawToken {
    value: string;
    quoted: boolean;
}

// Split on whitespace but keep double-quoted spans intact, merging a quote directly onto the token
// being built so `bookmark:"player manager"` scans as one token carrying the quoted flag.
function scan(input: string): RawToken[] {
    const out: RawToken[] = [];
    let cur = "";
    let quoted = false;
    let has = false;
    const flush = () => {
        if (has) out.push({ value: cur, quoted });
        cur = "";
        quoted = false;
        has = false;
    };
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (c === '"') {
            has = true;
            quoted = true;
            i++;
            while (i < input.length && input[i] !== '"') cur += input[i++];
            continue;
        }
        if (c === " " || c === "\t") {
            flush();
            continue;
        }
        has = true;
        cur += c;
    }
    flush();
    return out;
}

function normalizeGroup(raw: string): SearchGroup | undefined {
    const q = raw.toLowerCase();
    return SEARCH_GROUPS.find((g) => g.toLowerCase() === q);
}

export function parseQuery(raw: string): SearchQuery {
    const query: SearchQuery = { raw, text: "", tokens: [], phrases: [], negatives: [] };

    let body = raw.trimStart();
    // Leading prefix, e.g. "> split" or "@client".
    if (body.length > 0 && PREFIXES.includes(body[0] as Prefix)) {
        query.prefix = body[0] as Prefix;
        body = body.slice(1).trimStart();
    }

    const positives: string[] = [];
    for (const tok of scan(body)) {
        const v = tok.value;
        if (!tok.quoted && v.startsWith("-") && v.length > 1) {
            query.negatives.push(v.slice(1).toLowerCase());
            continue;
        }
        const colon = v.indexOf(":");
        if (colon > 0) {
            const key = v.slice(0, colon).toLowerCase();
            const rest = v.slice(colon + 1);
            if (key === "group") {
                const g = normalizeGroup(rest);
                if (g) query.groupFilter = g;
                else query.error = `Unknown group "${rest}"`;
                continue;
            }
            if (SCOPE_SET.has(key)) {
                query.scope = key as ScopeName;
                if (rest) {
                    positives.push(rest);
                    if (tok.quoted) query.phrases.push(rest.toLowerCase());
                }
                continue;
            }
        }
        positives.push(v);
        if (tok.quoted) query.phrases.push(v.toLowerCase());
    }

    query.text = positives.join(" ").trim();
    query.tokens = positives
        .flatMap((p) => p.split(/\s+/))
        .map((w) => w.toLowerCase())
        .filter(Boolean);
    return query;
}

// Does this query carry any actual search intent, or is it just an empty scaffold (prefix/scope
// with no text)? Empty-intent queries drive the recents/suggestions view.
export function hasQueryText(q: SearchQuery): boolean {
    return q.text.length > 0;
}
