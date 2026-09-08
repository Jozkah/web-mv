import { createMemo, createSignal } from "solid-js";
import type { AxClient } from "../transport/AxClient";
import { AxError } from "../transport/AxClient";
import { ErrorCode } from "../protocol/messages";
import { uiList, uiSet } from "../protocol/requests";
import type { UiControl } from "../protocol/types";
import type { CapabilitiesStore } from "./capabilitiesStore";
import { errorText } from "./errors";

// Menu control: lists and toggles the connected ext agent's own overlay controls (checkbox/
// slider/combo) over the ui_list/ui_get/ui_set lane. Gated on the negotiated menu.control
// capability — never calls the agent when it is unavailable. Danger-flagged controls are refused
// by the agent (error code 1024 / ErrorCode.MenuControlDisarmed) until the operator clicks ARM in
// the overlay; that error is surfaced to the caller rather than silently dropped.

export interface MenuControlStoreDeps {
    client: AxClient;
    capabilities: CapabilitiesStore;
}

export function createMenuControlStore(deps: MenuControlStoreDeps) {
    const [controls, setControls] = createSignal<UiControl[]>([]);
    const [armed, setArmed] = createSignal(false);
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal<string>();

    const capStatus = createMemo(() => deps.capabilities.get("menu.control"));
    const available = createMemo(() => capStatus().available);

    function guard(): string | null {
        if (!available()) return "menu.control capability unavailable (extension agent not connected, or ui_list not advertised)";
        return null;
    }

    // Refresh the whole control list (+ arm state) from the agent.
    async function refresh(): Promise<string | null> {
        const g = guard();
        if (g) { setError(g); return g; }
        setLoading(true);
        setError(undefined);
        try {
            const res = await uiList(deps.client);
            setControls(res.results);
            setArmed(res.armed);
            return null;
        } catch (e) {
            if (e instanceof AxError && e.code === ErrorCode.UnknownType) deps.capabilities.reportVerbError("ui_list", e);
            const msg = errorText(e);
            setError(msg);
            return msg;
        } finally {
            setLoading(false);
        }
    }

    // Set one control. Updates that control's value from the echoed APPLIED value (never assumes
    // the requested value took effect verbatim — sliders/combos clamp on the agent side). A danger
    // control set while disarmed comes back as AxError(MenuControlDisarmed); that message is
    // returned to the caller and stashed in `error()` so the view can show it.
    async function setControl(name: string, value: boolean | number): Promise<string | null> {
        const g = guard();
        if (g) { setError(g); return g; }
        setError(undefined);
        try {
            const res = await uiSet(deps.client, { name, value });
            setControls((cur) => cur.map((c) => (c.name === res.name ? { ...c, value: res.value } : c)));
            return null;
        } catch (e) {
            if (e instanceof AxError && e.code === ErrorCode.UnknownType) deps.capabilities.reportVerbError("ui_set", e);
            const msg = errorText(e);
            setError(msg);
            return msg;
        }
    }

    return {
        controls,
        armed,
        loading,
        error,
        available,
        capStatus,
        refresh,
        setControl,
    };
}

export type MenuControlStore = ReturnType<typeof createMenuControlStore>;
