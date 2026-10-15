import { describe, expect, it } from 'vitest';
import { CacheFn } from '@cachefn/core';
import { createAdminDispatcher, createAdminRegistry, MemoryAdminAuditSink, MemoryAdminIdempotencyStore } from '@superfunctions/admin';
import { createCacheFnDomainAdminAdapter } from '../index.js';

const context = {
  scope: { organizationId: 'installation_1', workspaceId: 'workspace_1', projectId: 'project_1', environmentId: 'environment_1', namespace: 'tenant_1' },
  actor: { id: 'operator_1', type: 'user' as const, permissions: ['*'] },
  requestId: 'request_1', correlationId: 'correlation_1', source: 'console' as const,
  idempotencyKey: 'operation_1',
};
function setup() {
  const cache = new CacheFn<unknown>({ name: 'dispatcher', namespace: 'tenant_1' });
  const registry = createAdminRegistry({
    enabledModules: ['cachefn'],
    adapters: [createCacheFnDomainAdminAdapter({ cache, environmentId: 'environment_1', namespace: 'tenant_1' })],
  });
  const audit = new MemoryAdminAuditSink();
  const dispatcher = createAdminDispatcher({ registry, audit, idempotency: new MemoryAdminIdempotencyStore(),
    // Deterministic verifier for this test; deployments must verify real scoped proof.
    confirmation: { verify: ({ token }) => token === 'test-confirmation' },
  });
  return { cache, registry, audit, dispatcher };
}

describe('CacheFn through shared admin dispatcher', () => {
  it('rejects unprivileged actors and invalid input before writing', async () => {
    const { cache, dispatcher } = setup();
    const denied = await dispatcher.dispatch({ operationId: 'cachefn.keys.set', input: { id: 'secret', value: 'private' }, context: { ...context, actor: { id: 'reader', permissions: ['cachefn.keys.read'] } } });
    expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await cache.has('secret')).toBe(false);
    const invalid = await dispatcher.dispatch({ operationId: 'cachefn.keys.set', input: { id: 'secret', value: 'private', ttl: -1 }, context });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
    expect(await cache.has('secret')).toBe(false);
  });
  it('requires confirmation and audit infrastructure before destructive operations', async () => {
    const { cache, dispatcher, registry } = setup();
    await cache.set('secret', 'private');
    const missingConfirmation = await dispatcher.dispatch({ operationId: 'cachefn.namespaces.clear', input: { id: 'tenant_1' }, context });
    expect(missingConfirmation).toMatchObject({ ok: false, error: { code: 'precondition_failed' } });
    const noAudit = createAdminDispatcher({ registry, confirmation: { verify: () => true }, idempotency: new MemoryAdminIdempotencyStore() });
    expect(await noAudit.dispatch({ operationId: 'cachefn.keys.delete', input: { id: 'secret' }, context: { ...context, confirmationToken: 'test-confirmation' } })).toMatchObject({ ok: false, error: { code: 'dependency_unavailable' } });
    expect(await cache.get('secret')).toBe('private');
  });
  it('audits redacted writes, rejects wrong scope and clears with confirmation', async () => {
    const { cache, dispatcher, audit } = setup();
    const written = await dispatcher.dispatch({ operationId: 'cachefn.keys.set', input: { id: 'secret', value: { token: 'never-log-this' } }, context });
    expect(written).toMatchObject({ ok: true, data: { accepted: true, id: 'secret' } });
    expect(written.auditId).toEqual(expect.any(String));
    expect(JSON.stringify(audit.events)).not.toContain('never-log-this');
    expect(audit.events.some(event => event.operationId === 'cachefn.keys.set' && event.outcome === 'succeeded')).toBe(true);
    for (const scope of [{ ...context.scope, environmentId: 'other' }, { ...context.scope, namespace: 'other' }]) {
      expect(await dispatcher.dispatch({ operationId: 'cachefn.keys.get', input: { id: 'secret' }, context: { ...context, scope, idempotencyKey: undefined } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    const cleared = await dispatcher.dispatch({ operationId: 'cachefn.namespaces.clear', input: { id: 'tenant_1' }, context: { ...context, idempotencyKey: 'clear_1', confirmationToken: 'test-confirmation' } });
    expect(cleared).toMatchObject({ ok: true, data: { accepted: true, id: 'tenant_1' } });
    expect(await cache.size()).toBe(0);
    expect(audit.events.some(event => event.operationId === 'cachefn.namespaces.clear' && event.outcome === 'succeeded')).toBe(true);
  });
});
