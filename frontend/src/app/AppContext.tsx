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
import { createCapabilitiesStore } from "../state/capabilitiesStore";
import type { SidecarId } from "../protocol/capabilities";
import { createTimelineStore } from "../timeline/timelineStore";
import { createTimelineProducers } from "../timeline/producers";
import { createTargetSession } from "../state/targetSession";
import { createWatchStore } from "../state/watchStore";
import { createEmulatorStore } from "../state/emulatorStore";
import { createPatchStore } from "../state/patchStore";
import { createProjectStore } from "../state/projectStore";
import { createGhidraConfig } from "../state/ghidraConfig";
import { createDecompilerStore } from "../state/decompilerStore";
import { createTsharkConfig } from "../state/tsharkConfig";
import { createNetworkStore } from "../state/networkStore";
import { dump as dumpRequest, peHeader } from "../protocol/requests";
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
    // The agent's ping carries no executable name, but the module list does: the main module is the
    // one mapped at `base`. Resolve its file name so the UI can show "game.exe" beside the pid.
    const processName = createMemo(() => {
        const b = base();
        if (!b) return undefined;
        return modules.list().find((m) => m.base === b)?.name;
    });

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
    // The core Echo agent (read/scan/disassemble). Its socket routes are static, so its mere
    // presence decides every angel-native capability. Falls back to relay-open when /status is stale.
    const coreConnected = createMemo(() => statusPoll.data()?.agent === true);

    // --- Per-target workspace key ---------------------------------------------------------------
    // liveKey follows whatever process the agent is attached to. workspaceKey is the effective
    // namespace every per-target store reads: normally the live target, but the user can override
    // it via the target tabs to view a previously-attached target's saved workspace. Following live
    // (override === null) snaps back to the attached process the instant it changes.
    const liveKey = createMemo(() => deriveWorkspaceKey(attached(), pid(), base()));
    const [targetOverride, setTargetOverride] = createSignal<string | null>(null);
    const workspaceKey = createMemo(() => targetOverride() ?? liveKey());

    // Atomic target-transition authority: a single source computes previous/new target, the new
    // generation, and the attach/detach/change classification as one value. Generation is raised
    // before any target-dependent async work, and correctness never depends on Solid effect order.
    const targetIdentity = createMemo(() => ({ key: liveKey(), pid: pid(), base: base() }));
    const targetSession = createTargetSession(targetIdentity);
    const targetGeneration = targetSession.generation;

    // Optional local sidecars (Ghidra decompiler, tshark PCAP, capture backend). None are configured
    // by default; a future sidecar detector flips these, and capability negotiation reflects them so
    // the decompiler/network views render an honest available/unavailable state — never a fake one.
    const [sidecars, setSidecars] = createSignal<Partial<Record<SidecarId, boolean>>>({});
    const setSidecar = (id: SidecarId, present: boolean) => setSidecars((s) => ({ ...s, [id]: present }));

    // Typed capability handshake: negotiate the live capability set from the two agents' connection
    // state plus the ext agent's advertised verb list. Every gated feature renders from this. A new
    // target generation renegotiates any per-connection verb downgrades.
    const capabilities = createCapabilitiesStore(client, { coreConnected, extConnected, targetGeneration, sidecars });

    // Global registry of every target the user has attached to (the target-tab index). Upsert the
    // live target whenever it resolves so the strip can offer it later.
    const [targets, setTargets] = createSignal<TargetInfo[]>(loadTargets());
    createEffect(() => {
        const key = liveKey();
        if (key === NO_TARGET_KEY) return;
        // Read processName() so this re-runs (and back-fills the name) once the module list loads.
        const name = processName();
        setTargets((cur) => {
            // Keep a previously-resolved name if the module list hasn't reloaded yet this attach.
            const prev = cur.find((t) => t.key === key);
            const info: TargetInfo = { key, pid: pid(), base: base(), name: name ?? prev?.name, lastSeen: Date.now() };
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

    // Unified event timeline: a central, bounded store fed by producers wired to activity the repo
    // already supports (connection lifecycle, target attach/detach, module loads, capability
    // handshake). Future providers (Memory Watch, emulator, patches, network) push to the same store.
    const timeline = createTimelineStore();
    createTimelineProducers(
        {
            relayStatus,
            coreConnected,
            extConnected,
            attached,
            pid,
            base,
            processName,
            targetTransition: targetSession.transition,
            targetGeneration,
            modulesStatus: modules.status,
            modulesList: modules.list,
            handshake: capabilities.handshake,
            availableCapabilities: () => capabilities.availableCount(),
            totalCapabilities: () => capabilities.totalCount(),
            downgradedVerbs: capabilities.downgradedVerbs,
        },
        timeline,
    );

    // Memory Watch: Angel-polling change watcher. Reads through the core agent, emits batched events
    // into the timeline, and is gated on the negotiated `memory.read` / `memory.watchPolling`.
    const watches = createWatchStore({
        client,
        timeline,
        capabilities,
        modules: modules.list,
        coreConnected,
        attached,
        liveKey,
        targetSession,
    });

    // Unicorn emulator: offline/process-backed emulation via the ext agent `emulate` verb. Gated on
    // the negotiated emulation.unicorn capability; sessions bind to the target generation at creation.
    const emulator = createEmulatorStore({
        client,
        timeline,
        capabilities,
        modules: modules.list,
        coreConnected,
        extConnected,
        attached,
        targetSession,
    });

    // Safe patch workspace: raw-byte patches through the Angel `write` verb, originals always
    // retained. Gated on patch.rawBytes; never auto-applies saved patches.
    const patches = createPatchStore({
        client,
        timeline,
        capabilities,
        modules: modules.list,
        attached,
        liveKey,
        targetSession,
    });

    const sidecarOrigin = `${location.protocol}//${location.host}`;

    // Optional tshark PCAP sidecar — OFFLINE analysis of a capture file the user already has. It never
    // captures live packets and is NOT correlated to the attached Angel target (a pcap carries no PID/
    // socket ownership). Created before the project store so its inert metadata joins the bundle.
    const tshark = createTsharkConfig();
    const network = createNetworkStore({
        config: tshark.config,
        capabilities,
        timeline,
        setSidecar,
        transport: {
            probe: (config) => fetch(`${sidecarOrigin}/tshark/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config }) }).then((r) => r.json()),
            analyze: (config, job) => fetch(`${sidecarOrigin}/tshark/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config, job }) }).then((r) => r.json()),
        },
    });

    // Project database: gather the per-target workspace (watches, patches, cheat, inert network
    // metadata) into one versioned bundle; import scatters it back inert (no auto-apply, no sidecar);
    // compare two bundles for a diff.
    const project = createProjectStore({
        watches,
        patches,
        cheat,
        network,
        fingerprint: () => {
            const b = base();
            const main = b ? modules.list().find((m) => m.base === b) : undefined;
            return { key: liveKey(), pid: pid(), base: b, name: processName(), mainModuleSize: main?.size };
        },
    });

    // Optional Ghidra headless decompiler (Phase 15). Local, user-supplied install; Angel dumps the
    // module, the relay runs Ghidra, results map back to live addresses. Static analysis only.
    const ghidra = createGhidraConfig();
    const ghidraOrigin = sidecarOrigin;
    const decompiler = createDecompilerStore({
        config: ghidra.config,
        capabilities,
        timeline,
        setSidecar,
        modules: modules.list,
        liveBaseOf: (name) => modules.baseOf(name),
        imageBaseOf: async (name) => {
            try {
                const r = await peHeader(client, { module: name });
                return r.image_base;
            } catch {
                return undefined;
            }
        },
        dumpModule: async (name) => {
            try {
                const r = await dumpRequest(client, { module: name });
                return { ok: r.success, path: r.path };
            } catch (e) {
                return { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
        },
        targetSession,
        transport: {
            probe: (config) => fetch(`${ghidraOrigin}/ghidra/probe`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config }) }).then((r) => r.json()),
            analyze: (config, job) => fetch(`${ghidraOrigin}/ghidra/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config, job }) }).then((r) => r.json()),
            decompile: (config, job) => fetch(`${ghidraOrigin}/ghidra/decompile`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config, job }) }).then((r) => r.json()),
        },
    });

    return {
        client,
        relayStatus,
        pingData,
        activeAgents,
        extConnected,
        coreConnected,
        capabilities,
        sidecars,
        setSidecar,
        timeline,
        watches,
        emulator,
        patches,
        project,
        ghidra,
        decompiler,
        tshark,
        network,
        targetGeneration,
        targetSession,
        attached,
        pid,
        base,
        processName,
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
