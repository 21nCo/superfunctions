import { afterEach, expect, it, vi } from "vitest";
import { WatchFn } from "../../src/core/watch-fn";
import type { WatchFnConfig } from "../../src/core/types";
const active: WatchFn[] = [];
function setup(auth?: WatchFnConfig['auth']) {
  const watch = new WatchFn({ name: 'private', storage: 'memory', infra: { enabled: false }, auth });
  active.push(watch); watch.start(); return watch;
}
afterEach(async () => { await Promise.all(active.splice(0).map(watch => watch.stop())); });
it.each([undefined, {}, { enabled: true }, { apiKey: '' }])('denies protected HTTP before body/storage access with auth %j', async auth => {
  const watch = setup(auth);
  await watch.ingest([{ name: 'host-only' }]);
  expect(await watch.query({})).toHaveLength(1);
  const query = vi.spyOn(watch, 'query'), ingest = vi.spyOn(watch, 'ingest'), status = vi.spyOn(watch, 'getBugIssueStatus');
  for (const path of ['/ingest', '/query', '/issues/status']) {
    const request = new Request(`http://local${path}`, { method: 'POST', body: 'invalid-json' });
    expect((await watch.httpRouter.handle(request)).status).toBe(401);
    expect(request.bodyUsed).toBe(false);
    expect(watch.authorizeIngest(request)).toBe(false);
  }
  expect(query).not.toHaveBeenCalled(); expect(ingest).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled();
  expect((await watch.httpRouter.handle(new Request('http://local/health'))).status).toBe(200);
});
it('requires explicit disabled auth for anonymous HTTP access', async () => {
  const watch = setup({ enabled: false });
  const status = vi.spyOn(watch, 'getBugIssueStatus').mockResolvedValue(null);
  for (const [path, body, expected] of [['/ingest', { name: 'public' }, 202], ['/query', {}, 200], ['/issues/status', { app: 'app', reportId: 'id' }, 404]] as const) {
    expect((await watch.httpRouter.handle(new Request(`http://local${path}`, { method: 'POST', body: JSON.stringify(body) }))).status).toBe(expected);
  }
  expect(status).toHaveBeenCalledOnce();
});
it('compares complete UTF-8 credentials and preserves either supported header', async () => {
  const watch = setup({ apiKey: 'sécret' });
  for (const token of ['', 'secret', 'sécre', 'sécret-extra', 'Sécret']) {
    for (const headers of [{ authorization: `Bearer ${token}` }, { 'x-api-key': token }]) {
      expect(await watch.authorizeHttp(new Request('http://local/query', { headers }), 'watchfn:query')).toBe(401);
    }
  }
  for (const headers of [{ authorization: 'Bearer sécret' }, { 'x-api-key': 'sécret' }, { authorization: 'Bearer wrong', 'x-api-key': 'sécret' }]) {
    expect(await watch.authorizeHttp(new Request('http://local/query', { headers }), 'watchfn:query')).toBeNull();
  }
});
