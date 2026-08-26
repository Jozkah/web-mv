import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// Test runner config. The solid plugin compiles any JSX under test; the browser/development
// resolve conditions pick Solid's CLIENT build so signals/effects are actually reactive in
// tests (the default node condition would load the inert SSR build). Tests are plain node -
// the pure helpers need no DOM, and the poll-loop tests drive Solid roots + fake timers.
export default defineConfig({
    plugins: [solid()],
    resolve: {
        conditions: ["development", "browser"],
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.{ts,tsx}"],
    },
});
