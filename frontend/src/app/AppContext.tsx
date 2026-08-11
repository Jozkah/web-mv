import {
    createContext,
    createEffect,
    createMemo,
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
import { config } from "../config";
import { useWorkspace } from "./WorkspaceContext";

export type ViewId = "memory" | "static" | "strings" | "history";

function createAppState() {
    const client = new AxClient(config.relayUrl);
    client.connect();

    if (import.meta.hot) {
        import.meta.hot.dispose(() => client.disconnect());
    }

    const modules = createModulesStore(client);
    const annotations = createAnnotations();
    const history = createHistoryStore();

    const ws = useWorkspace();
    const activeView = createMemo<ViewId>(() => {
        const k = ws.activeTab1()?.kind;
        if (k === "static" || k === "strings" || k === "history") return k;
        return "memory";
    });
    const setActiveView = (v: ViewId) => ws.openOrFocusView(v);

    const relayStatus = client.status;
    const relayOpen = createMemo(() => relayStatus() === "open");

    const pingPoll = createPoll(() => ping(client), config.pingIntervalMs, relayOpen);

    const pingData = pingPoll.data;
    const attached = createMemo(() => pingData()?.attached === true);
    const pid = createMemo(() => pingData()?.pid);
    const base = createMemo(() => (pingData()?.attached ? pingData()?.base : undefined));

    const statusPoll = createPoll(
        () => fetch(config.statusUrl).then((r) => r.json() as Promise<{ agents: number }>),
        config.pingIntervalMs,
        relayOpen,
    );
    const activeAgents = createMemo(() => statusPoll.data()?.agents ?? 0);

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
        attached,
        pid,
        base,
        modules,
        annotations,
        history,
        activeView,
        setActiveView,
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
