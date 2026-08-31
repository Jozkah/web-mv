import { describe, expect, it } from "vitest";
import {
    CAPABILITY_SPECS,
    KNOWN_EXT_VERBS,
    negotiateCapabilities,
    type NegotiationState,
} from "../capabilities";

const NOTHING: NegotiationState = { coreConnected: false, ext: null };
const CORE_ONLY: NegotiationState = { coreConnected: true, ext: null };
const FULL: NegotiationState = {
    coreConnected: true,
    ext: { connected: true, verbs: KNOWN_EXT_VERBS, confirmed: true, protocolVersion: 1 },
};

// Capabilities that no Angel primitive can ever back — must stay unavailable even fully connected.
const ALWAYS_UNAVAILABLE = [
    "debug.live",
    "debug.breakpointsSoftware",
    "debug.breakpointsHardware",
    "debug.registers",
    "debug.threads",
    "trace.live",
    "hook.native",
    "patch.assemble",
    "patch.allocate",
] as const;

describe("negotiateCapabilities", () => {
    it("with nothing connected, only builtin capabilities are available", () => {
        const caps = negotiateCapabilities(NOTHING);
        expect(caps["memory.read"].available).toBe(false);
        expect(caps["memory.write"].available).toBe(false);
        expect(caps["memory.watchPolling"].available).toBe(false);
        // project.persist is frontend-only (browser storage) — available with no backend.
        expect(caps["project.persist"].available).toBe(true);
    });

    it("core agent alone lights up angel-native + read-derived capabilities", () => {
        const caps = negotiateCapabilities(CORE_ONLY);
        expect(caps["memory.read"].available).toBe(true);
        expect(caps["module.enumerate"].available).toBe(true);
        expect(caps["signature.scan"].available).toBe(true);
        expect(caps["disassembly.zydis"].available).toBe(true);
        // derived from memory.read:
        expect(caps["memory.watchPolling"].available).toBe(true);
        // ext-backed stay off:
        expect(caps["memory.write"].available).toBe(false);
        expect(caps["scan.value"].available).toBe(false);
    });

    it("core + ext lights up the write-family and scanner", () => {
        const caps = negotiateCapabilities(FULL);
        expect(caps["memory.write"].available).toBe(true);
        expect(caps["memory.regions"].available).toBe(true);
        expect(caps["module.exports"].available).toBe(true);
        expect(caps["scan.value"].available).toBe(true);
        expect(caps["patch.rawBytes"].available).toBe(true);
    });

    it("emulator + emulated trace stay unavailable until an 'emulate' verb is advertised", () => {
        const caps = negotiateCapabilities(FULL);
        // KNOWN_EXT_VERBS has no 'emulate' verb yet, so these are honestly off despite the uc:: primitive.
        expect(caps["emulation.unicorn"].available).toBe(false);
        expect(caps["trace.emulated"].available).toBe(false);
        expect(caps["emulation.unicorn"].missingPrimitive).toContain("emulate");
        // ...but they light up once the agent advertises it.
        const withEmu = negotiateCapabilities({
            coreConnected: true,
            ext: { connected: true, verbs: [...KNOWN_EXT_VERBS, "emulate"], confirmed: true },
        });
        expect(withEmu["emulation.unicorn"].available).toBe(true);
        expect(withEmu["trace.emulated"].available).toBe(true);
    });

    it("a missing ext verb disables exactly its capability", () => {
        const noWrite = KNOWN_EXT_VERBS.filter((v) => v !== "write");
        const caps = negotiateCapabilities({ coreConnected: true, ext: { connected: true, verbs: noWrite, confirmed: true } });
        expect(caps["memory.write"].available).toBe(false);
        expect(caps["patch.rawBytes"].available).toBe(false);
        // unrelated ext verb still works:
        expect(caps["scan.value"].available).toBe(true);
    });

    it("distinguishes confirmed / assumed / derived / unavailable / disconnected provenance", () => {
        // Confirmed: core connected + ext verb list came from the agent's reply.
        const confirmed = negotiateCapabilities(FULL);
        expect(confirmed["memory.read"].provenance).toBe("confirmed"); // core
        expect(confirmed["memory.write"].provenance).toBe("confirmed"); // ext verb, confirmed list
        expect(confirmed["memory.watchPolling"].provenance).toBe("derived");
        expect(confirmed["debug.live"].provenance).toBe("unavailable"); // no primitive
        // Assumed: ext connected but the verb list was assumed (older agent).
        const assumed = negotiateCapabilities({
            coreConnected: true,
            ext: { connected: true, verbs: KNOWN_EXT_VERBS, confirmed: false },
        });
        expect(assumed["memory.write"].available).toBe(true);
        expect(assumed["memory.write"].provenance).toBe("assumed");
        // Disconnected: backing agent not connected.
        const nothing = negotiateCapabilities(NOTHING);
        expect(nothing["memory.read"].provenance).toBe("disconnected");
        expect(nothing["memory.write"].provenance).toBe("disconnected");
        expect(nothing["decompiler.ghidra"].provenance).toBe("disconnected");
    });

    it("a downgraded verb becomes unavailable even though it is in the assumed list", () => {
        const caps = negotiateCapabilities({
            coreConnected: true,
            ext: { connected: true, verbs: KNOWN_EXT_VERBS, confirmed: false, downgraded: ["write"] },
        });
        // 'write' was assumed then proven unsupported at call time → unavailable, not assumed.
        expect(caps["memory.write"].available).toBe(false);
        expect(caps["memory.write"].provenance).toBe("unavailable");
        expect(caps["patch.rawBytes"].available).toBe(false);
        // other assumed verbs unaffected by the downgrade of 'write':
        expect(caps["scan.value"].available).toBe(true);
        expect(caps["scan.value"].provenance).toBe("assumed");
    });

    it("emulator + emulated trace become available (confirmed) when the agent advertises 'emulate'", () => {
        const withEmu = negotiateCapabilities({
            coreConnected: true,
            ext: { connected: true, verbs: [...KNOWN_EXT_VERBS, "emulate"], confirmed: true },
        });
        expect(withEmu["emulation.unicorn"].available).toBe(true);
        expect(withEmu["emulation.unicorn"].provenance).toBe("confirmed");
        expect(withEmu["trace.emulated"].available).toBe(true);
        // Without the verb they stay off (KNOWN_EXT_VERBS has no 'emulate').
        expect(negotiateCapabilities(FULL)["emulation.unicorn"].available).toBe(false);
    });

    it("scan.pointer is derived from memory.read (available with the core agent)", () => {
        expect(negotiateCapabilities(FULL)["scan.pointer"].available).toBe(true);
        expect(negotiateCapabilities(FULL)["scan.pointer"].provenance).toBe("derived");
        // Off (and points at the value scanner) when the core agent is disconnected.
        const off = negotiateCapabilities(NOTHING)["scan.pointer"];
        expect(off.available).toBe(false);
        expect(off.alternative).toBe("scan.value");
    });

    it("optional sidecars gate on detected presence", () => {
        const off = negotiateCapabilities(FULL);
        expect(off["decompiler.ghidra"].available).toBe(false);
        expect(off["network.pcapImport"].available).toBe(false);

        const on = negotiateCapabilities({ ...FULL, sidecars: { ghidra: true, tshark: true } });
        expect(on["decompiler.ghidra"].available).toBe(true);
        expect(on["network.pcapImport"].available).toBe(true);
        expect(on["network.liveCapture"].available).toBe(false); // capture backend still absent
    });

    it("permanently-unavailable capabilities stay off even fully connected, with a missing primitive", () => {
        const caps = negotiateCapabilities({ ...FULL, sidecars: { ghidra: true, tshark: true, capture: true } });
        for (const id of ALWAYS_UNAVAILABLE) {
            expect(caps[id].available, `${id} must be unavailable`).toBe(false);
            expect(caps[id].missingPrimitive, `${id} needs a missing primitive`).toBeTruthy();
            expect(caps[id].reason, `${id} needs a user-facing reason`).toBeTruthy();
        }
    });

    it("every unavailable capability carries a machine-readable reason; available ones do not", () => {
        const caps = negotiateCapabilities(CORE_ONLY);
        for (const spec of CAPABILITY_SPECS) {
            const s = caps[spec.id];
            if (s.available) {
                expect(s.missingPrimitive).toBeUndefined();
            } else {
                // Every off capability must explain itself (reason) — except pure derived/connection
                // gaps which still carry a reason from the spec where one is defined.
                expect(typeof s.detail).toBe("string");
            }
        }
    });

    it("returns a status for every registered capability", () => {
        const caps = negotiateCapabilities(FULL);
        expect(Object.keys(caps).length).toBe(CAPABILITY_SPECS.length);
    });
});
