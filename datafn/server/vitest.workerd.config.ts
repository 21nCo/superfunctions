import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { disableLoopbackKeepAliveTimeout, probeLoopbackKeepAlive } from "./__tests__/workerd/loopback-keep-alive.js";

// Keeps isolated-storage push and pop from failing with "Network connection lost."; see loopback-keep-alive.ts.
disableLoopbackKeepAliveTimeout();

/**
 * Runs the Drizzle SQLite conformance suite inside workerd against a local
 * Cloudflare D1 database provided by Miniflare; no Cloudflare account is used.
 */
export default defineWorkersConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["__tests__/workerd/**/*.test.ts"],
    testTimeout: 60_000,
    poolOptions: {
      workers: {
        isolatedStorage: true,
        singleWorker: true,
        miniflare: {
          compatibilityDate: "2025-11-13",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          serviceBindings: { LOOPBACK_KEEP_ALIVE_PROBE: probeLoopbackKeepAlive },
        },
      },
    },
  },
});
