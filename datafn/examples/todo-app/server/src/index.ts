import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDatafnServer } from "@datafn/server";
import { toHono } from "@superfunctions/http-hono";
import { ns } from "@datafn/core";
import { adapter } from "./db.js";
import schema from "./schema.datafn.js";

async function main() {
  // ── Create DataFn Server ───────────────────────────────────────────
  const datafn = await createDatafnServer({
    schema,
    db: adapter,

    // Authorization — allow everything in this example.
    // In production, inspect ctx (headers / session) and restrict per action.
    authorize: async (_ctx: any, _action: any, _payload: any) => true,

    // Namespace provider — hardcoded namespace so scoping can be verified.
    // Replace with real session/token extraction in production.
    // namespaceProvider: {
    //   getNamespace: (_ctx: any) => ns("user", _ctx.parsedBody?.clientId ?? "anonymous"),
    //   getActorId: (_ctx: any) => _ctx.parsedBody?.clientId ?? "anonymous",
    // },
    namespaceProvider: {
      getNamespace: (_ctx: any) => "multiclienttest",
      getActorId: (_ctx: any) => "multiclienttestuser",
    },

    // Limits
    limits: {
      maxLimit: 200,
      maxTransactSteps: 50,
    },
  });

  // ── Hono HTTP App ──────────────────────────────────────────────────
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Length"],
      maxAge: 86400,
      credentials: false,
    }),
  );

  // Mount all DataFn routes at /
  const datafnApp = toHono(datafn.router);
  app.route("/", datafnApp);

  // ── Start server ───────────────────────────────────────────────────
  const port = Number(process.env.PORT ?? 3001);
  console.log(`DataFn Todo Server running → http://localhost:${port}`);
  console.log(`  POST /datafn/query      — execute queries`);
  console.log(`  POST /datafn/mutation    — execute mutations`);
  console.log(`  POST /datafn/transact    — execute transactions`);
  console.log(`  POST /datafn/clone       — full sync download`);
  console.log(`  POST /datafn/pull        — incremental sync`);
  console.log(`  POST /datafn/push        — upload local mutations`);
  console.log(`  GET  /datafn/status      — server status`);

  serve({ fetch: app.fetch, port });
}

main().catch(console.error);
