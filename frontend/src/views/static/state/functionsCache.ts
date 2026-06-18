import type { AxClient } from "../../../transport/AxClient";
import { axErrorMessage } from "../../../transport/AxClient";
import { ErrorCode } from "../../../protocol/messages";
import { enumerateFunctions } from "../../../protocol/requests";
import type { FunctionEntry } from "../../../protocol/types";
import { createAsyncCache } from "../../../state/asyncCache";

// Per-module function lists, keyed by module name. Switching modules back and forth is
// instant after the first enumerate; refresh re-runs it. enumerate_failed (an empty
// module) arrives as an AxError, which we translate to a calm message rather than a scary
// protocol string.

export function createFunctionsCache(client: AxClient) {
    return createAsyncCache<FunctionEntry[]>(
        async (module) => (await enumerateFunctions(client, { module })).results,
        (e) => axErrorMessage(e, ErrorCode.EnumerateFailed, "no functions found in this module"),
    );
}

export type FunctionsCache = ReturnType<typeof createFunctionsCache>;
