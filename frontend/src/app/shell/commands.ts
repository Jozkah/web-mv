import type { JSX } from "solid-js";
import { load, save } from "../../state/persist";

// A single command-palette entry. `run` performs the action; `kbd` is a display-only shortcut hint.
export interface Command {
    id: string;
    title: string;
    group: "Views" | "Actions" | "Targets" | "Recent";
    icon?: string;
    hint?: string;
    kbd?: string;
    keywords?: string;
    run: () => void;
}

// Subsequence fuzzy match with light scoring: every query char must appear in order. Consecutive
// matches, word-boundary matches and a shorter target all score higher. Returns null on no match.
export function fuzzyScore(query: string, text: string): number | null {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (q.length === 0) return 0;
    let score = 0;
    let ti = 0;
    let prevMatch = -2;
    for (let qi = 0; qi < q.length; qi++) {
        const c = q[qi];
        let found = -1;
        for (let i = ti; i < t.length; i++) {
            if (t[i] === c) {
                found = i;
                break;
            }
        }
        if (found === -1) return null;
        score += 10;
        if (found === prevMatch + 1) score += 8; // consecutive
        if (found === 0 || /[\s/_.:-]/.test(t[found - 1])) score += 6; // word boundary
        prevMatch = found;
        ti = found + 1;
    }
    score -= t.length * 0.2; // prefer tighter targets
    return score;
}

export interface Scored {
    cmd: Command;
    score: number;
}

export function rankCommands(query: string, cmds: Command[]): Scored[] {
    const q = query.trim();
    if (!q) return [];
    const out: Scored[] = [];
    for (const cmd of cmds) {
        const hay = `${cmd.title} ${cmd.keywords ?? ""} ${cmd.group}`;
        const s = fuzzyScore(q, hay);
        if (s !== null) out.push({ cmd, score: s });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
}

// Recently-run command ids, persisted so the palette can lead with the user's own frequent actions.
const RECENT_KEY = "ax.palette.recent";
const RECENT_VERSION = 1;
const RECENT_MAX = 8;

export function loadRecent(): string[] {
    const saved = load<string[]>(RECENT_KEY, RECENT_VERSION);
    return Array.isArray(saved) ? saved : [];
}

export function recordRecent(id: string): string[] {
    const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    save(RECENT_KEY, RECENT_VERSION, next);
    return next;
}

// Solid's JSX type re-export keeps the palette component's icon slot honest without importing here.
export type { JSX };
