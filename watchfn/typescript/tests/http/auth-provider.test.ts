import { afterEach, expect, it, vi } from "vitest";
import { WatchFn } from "../../src/core/watch-fn";
import type { AuthSession } from "@superfunctions/auth";
const active: WatchFn[] = [];
const session = (scopes: string[], extra = {}): AuthSession => ({ id: "browser", type: "api-key", subject: { actorId: "browser", actorType: "api-key" }, scopes, ...extra });
function setup(authenticate: (request: Request) => Promise<AuthSession | null>) {
  const watch = new WatchFn({ name: "scoped", storage: "memory", infra: { enabled: false }, auth: { apiKey: "legacy", provider: { authenticate } } });
  active.push(watch); watch.start(); return watch;
}
const request = (path: string, body = "{}", token = "browser") => new Request(`http://local${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body });
afterEach(async () => { await Promise.all(active.splice(0).map(watch => watch.stop())); });
it("separates ingestion, query and issue-status authority before body reads", async () => {
  const watch = setup(async req => req.headers.get("authorization") === "Bearer browser" ? session(["watchfn:ingest"]) : session(["watchfn:query"]));
  expect((await watch.httpRouter.handle(request("/ingest", JSON.stringify({name:"private-event"})))).status).toBe(202);
  for (const path of ["/query", "/issues/status"]) {
    const req = request(path, "invalid-json");
    expect((await watch.httpRouter.handle(req)).status).toBe(403); expect(req.bodyUsed).toBe(false);
  }
  const result = await watch.httpRouter.handle(request("/query", "{}", "operator"));
  expect(result.status).toBe(200); expect((await result.json()).results).toHaveLength(1);
  const denied = request("/ingest", "invalid", "operator");
  expect((await watch.httpRouter.handle(denied)).status).toBe(403); expect(denied.bodyUsed).toBe(false);
});
it("grants status separately without granting query", async () => {
  const watch = setup(async () => session(["watchfn:issues:status"]));
  const status = vi.spyOn(watch,"getBugIssueStatus").mockResolvedValue(null);
  expect((await watch.httpRouter.handle(request("/issues/status", JSON.stringify({app:"shop",reportId:"report"})))).status).toBe(404);
  expect(status).toHaveBeenCalledOnce();
  expect((await watch.httpRouter.handle(request("/query"))).status).toBe(403);
});
it.each([null, {}, session([]), session(["*"]), session(["watchfn:query"],{expiresAt:new Date(0)}), session(["watchfn:query"],{expiresAt:new Date(NaN)})])("fails closed for absent, malformed, expired or insufficient authority", async value => {
  const watch = setup(async () => value as AuthSession | null);
  const req = request("/query", "invalid", "legacy");
  expect([401,403]).toContain((await watch.httpRouter.handle(req)).status); expect(req.bodyUsed).toBe(false);
  expect(watch.authorizeIngest(req)).toBe(false);
});
it("sanitizes provider failure without falling back to the legacy key", async () => {
  const watch = setup(async () => { throw new Error("secret-provider-detail"); });
  const req = request("/query", "invalid", "legacy");
  const result = await watch.httpRouter.handle(req);
  expect(result.status).toBe(503); expect(await result.text()).not.toContain("secret-provider-detail"); expect(req.bodyUsed).toBe(false);
});
it("rejects a disabled or malformed provider configuration", () => {
  expect(()=>new WatchFn({name:"bad",auth:{enabled:false,provider:{authenticate:async()=>null}}})).toThrow(/disabled/);
  expect(()=>new WatchFn({name:"bad",auth:{provider:{} as any}})).toThrow(/provider/);
});
