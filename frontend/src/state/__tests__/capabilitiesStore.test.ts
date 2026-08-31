import { describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createCapabilitiesStore } from "../capabilitiesStore";
import { AxClient, AxError } from "../../transport/AxClient";
import { ErrorCode } from "../../protocol/messages";

// Let Solid flush its effect/microtask queue and any pending promise chains settle.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// A fake AxClient whose request() runs the current handler. The store only ever calls request()
// for the `capabilities` verb, so a single swappable handler is enough.
function fakeClient(): { client: AxClient; setHandler: (h: () => Promise<unknown>) => void } {
    let handler: () => Promise<unknown> = () => Promise.reject(new AxError(ErrorCode.UnknownType, "unknown"));
    const client = { request: () => handler() } as unknown as AxClient;
    return { client, setHandler: (h) => (handler = h) };
}

function verbsReply(verbs: string[]) {
    return () => Promise.resolve({ type: "capabilities_result", id: 1, success: true, protocol_version: 1, verbs });
}

describe("createCapabilitiesStore", () => {
    it("confirms capabilities from the agent reply, then renegotiates on reconnect", async () => {
        await createRoot(async (dispose) => {
            const { client, setHandler } = fakeClient();
            const [ext, setExt] = createSignal(false);
            const store = createCapabilitiesStore(client, {
                coreConnected: () => true,
                extConnected: ext,
            });

            // Connect with a confirmed reply.
            setHandler(verbsReply([...["write", "scan_new"]]));
            setExt(true);
            await tick();
            expect(store.handshake()).toBe("ready");
            expect(store.get("memory.write").provenance).toBe("confirmed");
            expect(store.get("scan.value").provenance).toBe("confirmed");

            // Drop → everything ext resets to disconnected.
            setExt(false);
            await tick();
            expect(store.handshake()).toBe("idle");
            expect(store.get("memory.write").provenance).toBe("disconnected");

            // Reconnect to an OLDER agent (UnknownType): renegotiate as assumed, not confirmed.
            setHandler(() => Promise.reject(new AxError(ErrorCode.UnknownType, "unknown ext verb")));
            setExt(true);
            await tick();
            expect(store.handshake()).toBe("assumed");
            expect(store.get("memory.write").available).toBe(true);
            expect(store.get("memory.write").provenance).toBe("assumed");

            dispose();
        });
    });

    it("downgrades an assumed verb proven unsupported, and clears it on reconnect", async () => {
        await createRoot(async (dispose) => {
            const { client, setHandler } = fakeClient();
            const [ext, setExt] = createSignal(false);
            const store = createCapabilitiesStore(client, {
                coreConnected: () => true,
                extConnected: ext,
            });

            setHandler(() => Promise.reject(new AxError(ErrorCode.UnknownType, "unknown")));
            setExt(true);
            await tick();
            expect(store.get("memory.write").available).toBe(true); // assumed

            // A live call to 'write' returns UnknownType → downgrade for this connection.
            const didDowngrade = store.reportVerbError("write", new AxError(ErrorCode.UnknownType, "unknown"));
            expect(didDowngrade).toBe(true);
            expect(store.get("memory.write").available).toBe(false);
            expect(store.get("memory.write").provenance).toBe("unavailable");
            expect(store.get("scan.value").available).toBe(true); // unrelated verb unaffected

            // Reconnect renegotiates: the downgrade must not persist.
            setExt(false);
            await tick();
            setExt(true);
            await tick();
            expect(store.downgradedVerbs()).toEqual([]);
            expect(store.get("memory.write").available).toBe(true);

            dispose();
        });
    });

    it("a transient (non-UnknownType) error never downgrades a capability", async () => {
        await createRoot(async (dispose) => {
            const { client, setHandler } = fakeClient();
            const [ext, setExt] = createSignal(false);
            const store = createCapabilitiesStore(client, {
                coreConnected: () => true,
                extConnected: ext,
            });

            // Even the handshake query failing transiently must not classify anything unsupported.
            setHandler(() => Promise.reject(new Error("request timed out")));
            setExt(true);
            await tick();
            expect(store.handshake()).toBe("assumed");
            expect(store.get("memory.write").available).toBe(true);

            // A timeout / disconnect on a live 'write' call is ignored (returns false, no downgrade).
            expect(store.reportVerbError("write", new Error("request timed out"))).toBe(false);
            expect(store.reportVerbError("write", new AxError(ErrorCode.NotAttached, "not attached"))).toBe(false);
            expect(store.get("memory.write").available).toBe(true);
            expect(store.downgradedVerbs()).toEqual([]);

            dispose();
        });
    });

    it("a new target generation clears per-connection downgrades", async () => {
        await createRoot(async (dispose) => {
            const { client, setHandler } = fakeClient();
            const [ext, setExt] = createSignal(false);
            const [gen, setGen] = createSignal(1);
            const store = createCapabilitiesStore(client, {
                coreConnected: () => true,
                extConnected: ext,
                targetGeneration: gen,
            });

            setHandler(verbsReply([...["write"]]));
            setExt(true);
            await tick();
            store.reportVerbUnsupported("write");
            expect(store.get("memory.write").available).toBe(false);

            // Attaching to a different process (new generation) renegotiates downgrades away.
            setGen(2);
            await tick();
            expect(store.downgradedVerbs()).toEqual([]);
            expect(store.get("memory.write").available).toBe(true);

            dispose();
        });
    });
});
