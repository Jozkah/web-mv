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
import { config } from "../config";

// Cross-view application state: the transport client, the liveness poll, and the state
// that more than one view needs (the module list and the address annotations). Views read
// it via useApp() and add their own view-local state on top. Created once, under the
// render root, by AppProvider.

// The app's two page destinations. Sig/String Scan are not destinations - they are cards
// that pop down from the top bar over whichever destination is active. activeView lives
// here (not as a Shell-local signal) so a scan result's "create class" / "jump to function"
// action can switch the active view programmatically.
export type ViewId = "memory" | "static";

function createAppState() {
    const client = new AxClient(config.relayUrl);
    client.connect();

    // In dev, HMR re-runs this module and builds a fresh client. Tear the old one down on hot
    // dispose so it doesn't linger and fight the new socket at the relay (endless reconnect flap).
    if (import.meta.hot) {
        import.meta.hot.dispose(() => client.disconnect());
    }

    const modules = createModulesStore(client);
    const annotations = createAnnotations();

    const [activeView, setActiveView] = createSignal<ViewId>("memory");

    const relayStatus = client.status;
    const relayOpen = createMemo(() => relayStatus() === "open");

    // The app's baseline continuous poll: is the agent attached, and to what. Every other
    // request is fetch-on-demand. The memory viewer adds the one other continuous poll, over
    // the bytes it displays, but only while that view is mounted - nothing else polls.
    const pingPoll = createPoll(() => ping(client), config.pingIntervalMs, relayOpen);

    const pingData = pingPoll.data;
    const attached = createMemo(() => pingData()?.attached === true);
    const pid = createMemo(() => pingData()?.pid);
    const base = createMemo(() => (pingData()?.attached ? pingData()?.base : undefined));

    // The module list follows the attached base: load it when a process is present, reload
    // it when the base changes (re-attach / new process), drop it when the agent detaches.
    // Views hang their own address-keyed cache resets off `base` the same way.
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
        attached,
        pid,
        base,
        modules,
        annotations,
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
