import { dirname, join, normalize } from "path";
import { activeAgentCount, agentConnected, callAgent, extConnected, handlers, noteClient, type Role, type SocketData } from "./relay";
import { analyze as ghidraAnalyze, decompile as ghidraDecompile, probe as ghidraProbe, type AnalyzeJob, type DecompileJob, type GhidraConfig } from "./ghidra";
import { analyze as tsharkAnalyze, probeRun as tsharkProbeRun, type AnalyzeJob as TsharkJob, type TsharkConfig } from "./tshark";

// Local control channel into a process's memory. Defaults to loopback. Set HOST to bind wider
// (HOST=0.0.0.0 to reach the UI from a phone/other device on the LAN) — see README "Phone / LAN
// access". There is NO auth on the relay: only bind beyond loopback on a trusted network, never
// expose the port to the internet without a TLS reverse proxy that adds authentication.
const HOSTNAME = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 9000);

// Ceiling for a single POST /rpc call. Generous so a slow point read or a single-threaded
// agent busy behind other callers still completes, but bounded so a wedged agent doesn't
// pin a request forever. Whole-module scans/enumerate belong on the browser UI, not here.
const RPC_TIMEOUT_MS = 30_000;

// Permissive CORS so a browser-based tool (not just curl) can call /rpc from any origin;
// the server only ever binds loopback, so this exposes nothing beyond the local machine.
const CORS_HEADERS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
};

function jsonResponse(body: string, status: number): Response {
    return new Response(body, {
        status,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
}

// Forward one protocol frame to the agent and return its raw JSON reply. The POST body is
// a wire frame, e.g. {"type":"read","address":"0x...","size":8}. Any `id` is assigned by
// the relay so concurrent callers never collide.
async function handleRpc(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse(JSON.stringify({ error: "POST only" }), 405);

    let frame: unknown;
    try {
        frame = JSON.parse(await req.text());
    } catch {
        return jsonResponse(JSON.stringify({ error: "body must be JSON" }), 400);
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
        return jsonResponse(JSON.stringify({ error: "frame must be a JSON object" }), 400);
    }
    if (typeof (frame as { type?: unknown }).type !== "string") {
        return jsonResponse(JSON.stringify({ error: "frame.type (string) is required" }), 400);
    }

    // Callers self-identify so the UI can show how many are active. Missing header collapses
    // to one shared "anon" bucket - the read still works, it just won't be counted separately.
    noteClient(req.headers.get("x-mv-client") ?? "anon");

    try {
        const reply = await callAgent(frame as Record<string, unknown>, RPC_TIMEOUT_MS);
        return jsonResponse(reply, 200); // reply is already the agent's JSON frame
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return jsonResponse(JSON.stringify({ error: message }), 502);
    }
}

// Optional Ghidra headless routes (loopback only, like everything else the relay binds). These run
// a LOCAL, user-supplied Ghidra install on an Angel-obtained dump file the relay reads from disk —
// no unbounded bytes cross the socket, and Ghidra never touches the target process.
const GHIDRA_ANALYZE_TIMEOUT_MS = 620_000; // must exceed the runner's own hard ceiling

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
    try {
        const body = JSON.parse(await req.text());
        return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

async function handleGhidraProbe(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse(JSON.stringify({ error: "POST only" }), 405);
    const body = await readJsonBody(req);
    const config = body?.config as GhidraConfig | undefined;
    if (!config) return jsonResponse(JSON.stringify({ error: "config required" }), 400);
    return jsonResponse(JSON.stringify(ghidraProbe(config)), 200);
}

async function handleGhidraAnalyze(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse(JSON.stringify({ error: "POST only" }), 405);
    const body = await readJsonBody(req);
    const config = body?.config as GhidraConfig | undefined;
    const job = body?.job as AnalyzeJob | undefined;
    if (!config || !job) return jsonResponse(JSON.stringify({ error: "config and job required" }), 400);
    try {
        const result = await Promise.race([
            ghidraAnalyze(config, job),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("relay ghidra timeout")), GHIDRA_ANALYZE_TIMEOUT_MS)),
        ]);
        return jsonResponse(JSON.stringify(result), 200);
    } catch (e) {
        return jsonResponse(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), durationMs: 0 }), 200);
    }
}

async function handleGhidraDecompile(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse(JSON.stringify({ error: "POST only" }), 405);
    const body = await readJsonBody(req);
    const config = body?.config as GhidraConfig | undefined;
    const job = body?.job as DecompileJob | undefined;
    if (!config || !job) return jsonResponse(JSON.stringify({ error: "config and job required" }), 400);
    try {
        const result = await Promise.race([
            ghidraDecompile(config, job),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("relay ghidra decompile timeout")), GHIDRA_ANALYZE_TIMEOUT_MS)),
        ]);
        return jsonResponse(JSON.stringify(result), 200);
    } catch (e) {
        return jsonResponse(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), durationMs: 0 }), 200);
    }
}

async function handleTsharkProbe(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse(JSON.stringify({ error: "POST only" }), 405);
    const body = await readJsonBody(req);
    const config = body?.config as TsharkConfig | undefined;
    if (!config) return jsonResponse(JSON.stringify({ error: "config required" }), 400);
    try {
        const result = await Promise.race([
            tsharkProbeRun(config),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("relay tshark probe timeout")), 30_000)),
        ]);
        return jsonResponse(JSON.stringify(result), 200);
    } catch (e) {
        return jsonResponse(JSON.stringify({ ok: false, pathValid: false, runnable: false, error: e instanceof Error ? e.message : String(e) }), 200);
    }
}

async function handleTsharkAnalyze(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse(JSON.stringify({ error: "POST only" }), 405);
    const body = await readJsonBody(req);
    const config = body?.config as TsharkConfig | undefined;
    const job = body?.job as TsharkJob | undefined;
    if (!config || !job) return jsonResponse(JSON.stringify({ error: "config and job required" }), 400);
    try {
        const result = await Promise.race([
            tsharkAnalyze(config, job),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("relay tshark timeout")), GHIDRA_ANALYZE_TIMEOUT_MS)),
        ]);
        return jsonResponse(JSON.stringify(result), 200);
    } catch (e) {
        return jsonResponse(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), durationMs: 0 }), 200);
    }
}

// The built frontend (frontend/dist) copied next to the executable as ./public. Resolved from
// the executable's own location so it works no matter where the launcher sets the working dir;
// override with UI_DIR when running from source. Serving the UI here keeps the whole tool to a
// single process and a single port - the browser loads from http://127.0.0.1:9000 and reaches
// the /ui websocket on that same origin (see frontend config).
const UI_DIR = process.env.UI_DIR ?? join(dirname(process.execPath), "public");

async function serveStatic(pathname: string): Promise<Response> {
    const rel = normalize(pathname === "/" ? "/index.html" : pathname);
    const full = join(UI_DIR, rel);
    // Refuse anything that escapes the UI directory (e.g. encoded "..").
    if (!full.startsWith(UI_DIR)) return new Response("forbidden", { status: 403 });

    const file = Bun.file(full);
    if (await file.exists()) return new Response(file);

    // Unknown path: fall back to the SPA entry so a deep link still loads the app.
    const index = Bun.file(join(UI_DIR, "index.html"));
    if (await index.exists()) return new Response(index);
    return new Response("ui not built (run build-release)", { status: 404 });
}

const server = Bun.serve({
    hostname: HOSTNAME,
    port: PORT,
    fetch(req, server) {
        const { pathname } = new URL(req.url);

        // Stateless HTTP lane: any number of concurrent callers, multiplexed onto the
        // one agent socket by the relay. This is the seam the VSCode chats use.
        if (pathname === "/rpc") return handleRpc(req);
        if (pathname === "/ghidra/probe") return handleGhidraProbe(req);
        if (pathname === "/ghidra/analyze") return handleGhidraAnalyze(req);
        if (pathname === "/ghidra/decompile") return handleGhidraDecompile(req);
        if (pathname === "/tshark/probe") return handleTsharkProbe(req);
        if (pathname === "/tshark/analyze") return handleTsharkAnalyze(req);

        // Liveness for the UI's "agents" badge: how many RPC callers are currently active.
        if (pathname === "/status") {
            return jsonResponse(
                JSON.stringify({
                    agents: activeAgentCount(),
                    agent: agentConnected(),
                    ext: extConnected(),
                }),
                200,
            );
        }

        const role: Role | null =
            pathname === "/agent" ? "agent"
            : pathname === "/agent-ext" ? "agent-ext"
            : pathname === "/ui" ? "ui"
            : null;

        // The two websocket endpoints upgrade; everything else is the static UI.
        if (role) {
            if (server.upgrade(req, { data: { role } satisfies SocketData })) {
                return undefined; // upgraded; Bun takes over the socket
            }
            return new Response("expected websocket upgrade", { status: 426 });
        }

        return serveStatic(pathname);
    },
    websocket: handlers,
});

console.log(`running at: http://${server.hostname}:${server.port}  (open this in a browser)`);
console.log(`agent runs at: ws://localhost:${server.port}/agent`);
console.log(`rpc runs at:   POST http://${server.hostname}:${server.port}/rpc  (many concurrent callers)`);
if (HOSTNAME !== "127.0.0.1" && HOSTNAME !== "localhost") {
    console.log(`LAN access: bound to ${HOSTNAME} — open http://<this-PC-LAN-IP>:${server.port} on another device.`);
    console.log(`WARNING: the relay has NO authentication. Trusted LAN only; never expose this port to the internet.`);
}

