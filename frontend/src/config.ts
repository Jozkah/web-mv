// Browser-side config. The relay's /ui endpoint and default poll cadence.
// The relay binds 127.0.0.1:8080; the browser reaches it via the same host it loaded from.

export const config = {
    // Derive the relay socket from whatever host:port served this page, so the
    // UI works on any PORT the server binds (8080 default, 9000, etc.) with no rebuild.
    relayUrl: `ws://${location.host}/ui`,
    // Relay's HTTP status endpoint (same origin) - reports how many RPC callers are active.
    statusUrl: `${location.protocol}//${location.host}/status`,
    pingIntervalMs: 1000,
    // Cadence for the memory viewer's live read of the active class's region. This is the
    // one other continuous poll besides ping, and only runs while the memory view is open.
    memoryPollIntervalMs: 250,
} as const;
