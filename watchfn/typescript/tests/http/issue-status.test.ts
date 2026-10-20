import { afterEach, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { WatchFn } from "../../src/core/watch-fn";
const active: WatchFn[] = [];
const ref = { app: "shop", reportId: "one" };
const event = { id: "one", type: "bug_report", app: { name: "shop" }, timestamp: "2026-10-20T00:00:00Z", sessionId: "session", context: {}, report: { title: "Bug", severity: "high" } };
function setup(enabled = true) {
  const watch = new WatchFn({ name: "shop", storage: "database", database: memoryAdapter(), infra: { enabled: false }, auth: { apiKey: "secret" }, ...(enabled ? { botfn: { namespace: "one", routes: [{ app: "shop", target: "github", project: "acme/bugs", client: { request: async (_path: string, options: RequestInit) => ({ number: 7, html_url: "https://github.com/acme/bugs/issues/7", body: JSON.parse(options.body as string).body }) } }] } } : {}) } as any);
  watch.start(); active.push(watch); return watch;
}
const request = (body: unknown, key = "secret") => new Request("http://local/issues/status", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
afterEach(async () => { for (const watch of active.splice(0)) await watch.stop(); });
it("authenticates before reading a bounded strict body", async () => {
  const watch = setup(); const req = request(ref, "wrong"); expect((await watch.httpRouter.handle(req)).status).toBe(401); expect(req.bodyUsed).toBe(false);
  for (const value of [null, [], {}, { ...ref, action: "reconcile" }, { ...ref, reportId: " " }]) expect((await watch.httpRouter.handle(request(value))).status).toBe(400);
  expect((await watch.httpRouter.handle(request({ ...ref, reportId: "x".repeat(4096) }))).status).toBe(413);
});
it("returns absent, pending and verified linked state without exposing private delivery fields", async () => {
  const watch = setup(); expect((await watch.httpRouter.handle(request(ref))).status).toBe(404); await watch.ingest([event]);
  let response = await watch.httpRouter.handle(request(ref)); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ...ref, target: "github", state: "pending", issueId: null, issueUrl: null });
  await watch.processBugIssues(); response = await watch.httpRouter.handle(request(ref)); expect(await response.json()).toEqual({ ...ref, target: "github", state: "linked", issueId: "7", issueUrl: "https://github.com/acme/bugs/issues/7" });
  expect((await watch.httpRouter.handle(request({ ...ref, app: "other" }))).status).toBe(404);
});
it("reports disabled integration as unavailable, never as successful delivery", async () => { expect((await setup(false).httpRouter.handle(request(ref))).status).toBe(503); });
