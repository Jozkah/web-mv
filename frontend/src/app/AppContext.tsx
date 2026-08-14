import {
    createContext,
    createEffect,
    createMemo,
    createSignal,
    on,
    useContext,
    type JSX,
} from "solid-js";
import { AxClient } from "../transport/AxClient";
import { createPoll } from "../polling/createPoll";
import { ping } from "../protocol/requests";
import { createModulesStore } from "../state/modulesStore";
import { createAnnotations } from "../state/annotations";
import { createHistoryStore } from "../state/historyStore";
import { createCheatStore } from "../state/cheatStore";
import { createBookmarksStore } from "../state/bookmarksStore";
import { createNavStore } from "../state/navStore";
import {
    deriveWorkspaceKey,
    loadTargets,
    saveTargets,
    NO_TARGET_KEY,
    type TargetInfo,
} from "../state/workspaceKey";
import { config } from "../config";
import { useWorkspace } from "./WorkspaceContext";

export type ViewId = "memory" | "static" | "strings" | "history" | "datatypes";

function createAppState() {
    const client = new AxClient(config.relayUrl);
    client.connect();

    if (import.meta.hot) {
        import.meta.hot.dispose(() => client.disconnect());
    }

    const modules = createModulesStore(client);
    const history = createHistoryStore();
    const cheat = createCheatStore();
    const bookmarks = createBookmarksStore();
    const nav = createNavStore();

    const ws = useWorkspace();
    const activeView = createMemo<ViewId>(() => {
        const k = ws.activeTab()?.kind;
        if (k === "static" || k === "strings" || k === "history") return k;
        return "memory";
    });
    const setActiveView = (v: ViewId, classId?: string) => ws.openOrFocusView(v, classId);

    const relayStatus = client.status;
    const relayOpen = createMemo(() => relayStatus() === "open");

    const pingPoll = createPoll(() => ping(client), config.pingIntervalMs, relayOpen);

    const pingData = pingPoll.data;
    const attached = createMemo(() => pingData()?.attached === true);
    const pid = createMemo(() => pingData()?.pid);
    const base = createMemo(() => (pingData()?.attached ? pingData()?.base : undefined));

    const statusPoll = createPoll(
        () =>
            fetch(config.statusUrl).then(
                (r) => r.json() as Promise<{ agents: number; agent?: boolean; ext?: boolean }>,
            ),
        config.pingIntervalMs,
        relayOpen,
    );
    const activeAgents = createMemo(() => statusPoll.data()?.agents ?? 0);
    // The extension agent (write/dump/exports/sections) is a separate socket; the write-family
    // features silently no-op without it, so surface its presence distinctly from the core agent.
    const extConnected = createMemo(() => statusPoll.data()?.ext === true);

    // --- Per-target workspace key ---------------------------------------------------------------
    // liveKey follows whatever process the agent is attached to. workspaceKey is the effective
    // namespace every per-target store reads: normally the live target, but the user can override
    // it via the target tabs to view a previously-attached target's saved workspace. Following live
    // (override === null) snaps back to the attached process the instant it changes.
    const liveKey = createMemo(() => deriveWorkspaceKey(attached(), pid(), base()));
    const [targetOverride, setTargetOverride] = createSignal<string | null>(null);
    const workspaceKey = createMemo(() => targetOverride() ?? liveKey());

    // Global registry of every target the user has attached to (the target-tab index). Upsert the
    // live target whenever it resolves so the strip can offer it later.
    const [targets, setTargets] = createSignal<TargetInfo[]>(loadTargets());
    createEffect(() => {
        const key = liveKey();
        if (key === NO_TARGET_KEY) return;
        const info: TargetInfo = { key, pid: pid(), base: base(), lastSeen: Date.now() };
        setTargets((cur) => {
            const next = [...cur.filter((t) => t.key !== key), info];
            saveTargets(next);
            return next;
        });
    });

    const annotations = createAnnotations(workspaceKey);

    createEffect(
        on(base, (b) => {
            if (b === undefined) modules.clear();
            else modules.load();
        }),
    );

    return {
        client,
        relayStatus,
        pingData,
        activeAgents,
        extConnected,
        attached,
        pid,
        base,
        modules,
        annotations,
        history,
        cheat,
        bookmarks,
        nav,
        activeView,
        setActiveView,

        // Workspace key + target tabs.
        workspaceKey,
        liveKey,
        targets,
        isFollowingLive: () => targetOverride() === null,
        selectTarget(key: string) {
            setTargetOverride(key);
        },
        followLive() {
            setTargetOverride(null);
        },
        forgetTarget(key: string) {
            setTargets((cur) => {
                const next = cur.filter((t) => t.key !== key);
                saveTargets(next);
                return next;
            });
            if (targetOverride() === key) setTargetOverride(null);
        },
    };
}

export type AppState = ReturnType<typeof createAppState>;

const AppContext = createContext<AppState>();

export function AppProvider(props: { children: JSX.Element }) {
    const state = createAppState();
    return <AppContext.Provider value={state}>{props.children}</AppContext.Provider>;
}

export function useApp(): AppState {
    const state = useContext(AppContext);
    if (!state) throw new Error("useApp must be used within an AppProvider");
    return state;
}
