/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describeDrizzleSqliteConformance } from "../drizzle-sqlite/suite.js";
import { createD1Harness } from "./d1-harness.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

describeDrizzleSqliteConformance("Cloudflare D1 (workerd)", () => createD1Harness(env.DB));
