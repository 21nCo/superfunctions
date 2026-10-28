import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const contracts = (path: string) => fileURLToPath(new URL(`../adapter-contracts/src/${path}`, import.meta.url));

/**
 * Runs the D1 suites inside workerd with a local D1 database; no Cloudflare account is used.
 *
 * The project root is the repository root because `searchfn/node_modules` holds a Vitest 1.x
 * toolchain that would otherwise shadow the root Vitest 3 packages the Workers pool loads.
 */
export default defineWorkersConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  resolve: {
    alias: {
      "@searchfn/adapter-contracts/testing": contracts("testing.ts"),
      "@searchfn/adapter-contracts": contracts("index.ts"),
    },
  },
  test: {
    dir: packageDir,
    include: ["__tests__/workerd/**/*.test.ts"],
    testTimeout: 60_000,
    poolOptions: {
      workers: {
        isolatedStorage: true,
        singleWorker: true,
        miniflare: {
          compatibilityDate: "2025-11-13",
          d1Databases: ["DB"],
        },
      },
    },
  },
});
