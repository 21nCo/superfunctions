import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

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
        },
      },
    },
  },
});
