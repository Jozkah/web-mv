import { dirname, join, normalize } from "path";
import { handlers, type Role, type SocketData } from "./relay";

// Local control channel into a process's memory - never bind to anything but loopback.
const HOSTNAME = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8080);

// The built frontend (frontend/dist) copied next to the executable as ./public. Resolved from
// the executable's own location so it works no matter where the launcher sets the working dir;
// override with UI_DIR when running from source. Serving the UI here keeps the whole tool to a
// single process and a single port - the browser loads from http://127.0.0.1:8080 and reaches
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
        const role: Role | null =
            pathname === "/agent" ? "agent" : pathname === "/ui" ? "ui" : null;

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
