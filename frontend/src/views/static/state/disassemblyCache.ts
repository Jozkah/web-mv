import type { AxClient } from "../../../transport/AxClient";
import { axErrorMessage } from "../../../transport/AxClient";
import { ErrorCode } from "../../../protocol/messages";
import { disassemble } from "../../../protocol/requests";
import type { DisassembleResult } from "../../../protocol/types";
import { createAsyncCache } from "../../../state/asyncCache";

// Disassembly keyed by absolute address. A function's disassembly is static for the
// attach, so we cache the full result (instructions + the `complete` flag). The extra
// `size` arg is the function's known length, forwarded to the loader so the agent decodes
// exactly the function.

export function createDisassemblyCache(client: AxClient) {
    return createAsyncCache<DisassembleResult, [size: number]>(
        (address, size) => disassemble(client, { address, size }),
        (e) => axErrorMessage(e, ErrorCode.DisassembleFailed, "no instructions decoded"),
    );
}

export type DisassemblyCache = ReturnType<typeof createDisassemblyCache>;
