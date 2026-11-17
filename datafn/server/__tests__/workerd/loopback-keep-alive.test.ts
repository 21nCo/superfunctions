/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { expect, it } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    LOOPBACK_KEEP_ALIVE_PROBE: Fetcher;
  }
}

// Isolated-storage push and pop travel over Miniflare's loopback server; if Node
// closes an idle pooled connection, the next pop fails with "Network connection lost." (DATA-37).
it("keeps an idle storage loopback connection open past Node's default keep-alive timeout", async () => {
  const response = await env.LOOPBACK_KEEP_ALIVE_PROBE.fetch("http://probe/");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ servers: [{ keepAliveTimeout: 0, idleConnectionReused: true }] });
});
