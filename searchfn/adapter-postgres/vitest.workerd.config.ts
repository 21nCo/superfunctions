import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const packageDir = fileURLToPath(new URL(".", import.meta.url));
const contracts = (path: string) => fileURLToPath(new URL(`../adapter-contracts/src/${path}`, import.meta.url));
const pgUrl = process.env.SEARCHFN_PG_URL ?? "postgres://searchfn:searchfn_test@localhost:5433/searchfn_test";

/** Whether the Postgres server accepts TCP connections, checked from Node before workerd starts. */
function reachable(url: string, timeoutMs = 2000): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port || 5432) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Runs the Workers suites inside workerd (Miniflare); no Cloudflare account is used.
 *
 * The HYPERDRIVE binding is a local Hyperdrive binding for the Postgres from
 * docker-compose.postgres.yml (or SEARCHFN_PG_URL). Miniflare connects to it directly, so this is
 * not a live Hyperdrive check. It is bound only when the server is reachable: a failed connection
 * attempt inside workerd surfaces as an unhandled socket error that fails the run.
 *
 * The project root is the repository root because `searchfn/node_modules` holds a Vitest 1.x
 * toolchain that would otherwise shadow the root Vitest 3 packages the Workers pool loads.
 */
export default defineWorkersConfig(async () => {
  const postgresUp = await reachable(pgUrl);
  return {
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
          singleWorker: true,
          miniflare: {
            compatibilityDate: "2025-11-13",
            // Hyperdrive drivers (postgres.js, pg) need nodejs_compat; the adapter itself imports node:crypto.
            compatibilityFlags: ["nodejs_compat"],
            hyperdrives: postgresUp ? { HYPERDRIVE: pgUrl } : {},
            bindings: { SEARCHFN_PG_REQUIRED: process.env.SEARCHFN_PG_REQUIRED ?? "" },
          },
        },
      },
    },
  };
});
