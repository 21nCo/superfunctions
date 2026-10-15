/** Current public package integrations; see ecosystem.md for scope and invocation. */
import { cacheFn, hashArgs, CacheFn } from '@cachefn/core';
import { MemoryAdapter } from '@searchfn/adapter-memory';
import type { IndexParams, SearchParams } from '@searchfn/adapter-contracts';
import type { AuthFnServer } from 'authfn';
import { verifySlackRequest } from '@superfunctions/botfn-slack-core';

/** Cache complete query options; invalidate completed index writes before returning. */
export function cachedSearch(adapter = new MemoryAdapter()) {
  const cache = new CacheFn<Array<string | number>>({ name: 'search-results', defaultTTL: 30000 });
  return {
    adapter,
    cache,
    async search(params: SearchParams) {
      // AbortSignals are operational state, not cache-key data. Honor an already-aborted request.
      if (params.signal?.aborted) throw params.signal.reason ?? new Error('Search aborted');
      // A caller-owned signal must not cancel another caller's shared cache fill.
      if (params.signal) return adapter.search(params);
      const { signal, ...query } = params;
      return cache.getOrFetch(hashArgs([query]), () => adapter.search(params), { tags: [`resource:${params.resource}`] });
    },
    async index(params: IndexParams) {
      await adapter.index(params);
      await cache.invalidateByTag(`resource:${params.resource}`);
    },
    async remove(resource: string, ids: Array<string | number>) {
      await adapter.remove({ resource, ids });
      await cache.invalidateByTag(`resource:${resource}`);
    },
    async dispose() { cache.dispose(); await adapter.dispose(); },
  };
}

/** Authenticate every request; cache only non-authoritative per-user profile data. */
export function cachedProfileRoute<T>(auth: AuthFnServer, loadProfile: (actorId: string) => Promise<T>) {
  const cache = new CacheFn<T>({ name: 'profile-data', defaultTTL: 30000 });
  return {
    cache,
    async handle(request: Request): Promise<Response> {
      const session = await auth.provider.authenticate(request);
      if (!session) return new Response('Unauthorized', { status: 401 });
      const profile = await cache.getOrFetch(session.actorId, () => loadProfile(session.actorId));
      return Response.json(profile);
    },
    async invalidateProfile(actorId: string) { await cache.delete(actorId); },
  };
}

/** Verify every Slack request before deduplication; process-local retry protection. */
export function cachedSlackHandler(signingSecret: string, process: (payload: Record<string, unknown>) => Promise<void>) {
  const completed: CacheFn<boolean> = cacheFn({ name: 'slack-events', defaultTTL: 300000 });
  return {
    cache: completed,
    async handle(request: Request): Promise<Response> {
      if (!await verifySlackRequest(request, signingSecret)) return new Response('Invalid signature', { status: 401 });
      const payload = await request.json() as Record<string, unknown>;
      if (typeof payload.event_id !== 'string') return new Response('Missing event_id', { status: 400 });
      await completed.getOrFetch(payload.event_id, async () => { await process(payload); return true; });
      return new Response('OK');
    },
  };
}
