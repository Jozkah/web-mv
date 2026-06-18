// Browser-side config. The relay's /ui endpoint and default poll cadence.
// The relay binds 127.0.0.1:8080; the browser reaches it via the same host it loaded from.

export const config = {
    relayUrl: `ws://${location.hostname}:8080/ui`,
    pingIntervalMs: 1000,
    // Cadence for the memory viewer's live read of the active class's region. This is the
    // one other continuous poll besides ping, and only runs while the memory view is open.
    memoryPollIntervalMs: 250,
} as const;
