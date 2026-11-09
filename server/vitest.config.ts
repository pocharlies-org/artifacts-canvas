import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests run real HTTP/WS servers; give them room.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Servers + sockets: keep files sequential to avoid port/timing flakiness.
    fileParallelism: false,
    pool: "forks",
  },
});
