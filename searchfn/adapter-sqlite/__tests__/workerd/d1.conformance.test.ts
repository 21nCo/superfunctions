/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe } from "vitest";
import { runConformanceSuite } from "@searchfn/adapter-contracts/testing";
import { SqliteAdapter, fromD1, type D1DatabaseLike } from "../../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1DatabaseLike;
  }
}

let run = 0;

describe("SqliteAdapter conformance (D1 in workerd)", () => {
  runConformanceSuite({
    name: "sqlite-d1",
    persistent: true,
    // A fresh table prefix per test keeps tests independent of storage isolation.
    create: () => new SqliteAdapter({ driver: fromD1(env.DB), tablePrefix: `conf${++run}` }),
  });
});
