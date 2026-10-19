import { expect, it } from 'vitest';
import { createAdminCapabilityAdapter, createAdminDispatcher, createAdminRegistry, defineAdminCapability, MemoryAdminAuditSink } from '@superfunctions/admin';
import { Logger, type LogEvent, type Sink } from '@logfn/core';
import { createLogFnAdminAdapter, createLogFnAdminService } from '../index.js';
const scope = { installationId: 'install', workspaceId: 'workspace', projectId: 'project', environmentId: 'environment', namespace: 'tenant' };
const context = { scope, actor: { id: 'operator', permissions: ['logfn.events.emit', 'logfn.sinks.flush'] }, requestId: 'request', source: 'rest' as const };
function setup(sink: Sink) {
  const owner = createAdminCapabilityAdapter(defineAdminCapability({ schemaVersion: '1.0', id: 'watchfn', displayName: 'WatchFn', version: '1.0.0', description: 'Test owner', category: 'observability', availability: 'optional-product', scopeLevels: ['organization', 'workspace', 'project', 'environment'], dependencies: [], navigation: [], resources: [], operations: [] }), {});
  const adapter = createLogFnAdminAdapter(createLogFnAdminService(new Logger({ name: 'admin', sinks: [sink], onError: () => {} }), scope));
  const audit = new MemoryAdminAuditSink();
  return { audit, dispatcher: createAdminDispatcher({ registry: createAdminRegistry({ adapters: [owner, adapter], enabledModules: ['watchfn', 'logfn'] }), audit }) };
}
it('dispatcher rejects invalid input, absent permission and cross-scope writes before delivery', async () => {
  const events: LogEvent[] = []; const { dispatcher } = setup(batch => { events.push(...batch); });
  const invoke = (input: unknown, ctx = context) => dispatcher.dispatch({ operationId: 'logfn.events.emit', input, context: ctx });
  expect(await invoke({ level: 'constructor', message: 'bad' })).toMatchObject({ ok: false, error: { code: 'invalid_argument' } });
  expect(await invoke({ level: 'info', message: 'valid' }, { ...context, actor: { id: 'denied', permissions: [] } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  expect(await invoke({ level: 'info', message: 'valid' }, { ...context, scope: { ...scope, namespace: 'other' } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  expect(events).toEqual([]);
});
it('protects actor attribution from supplied context and redacts audit context', async () => {
  const events: LogEvent[] = []; const { dispatcher, audit } = setup(batch => { events.push(...batch); });
  expect(await dispatcher.dispatch({ operationId: 'logfn.events.emit', context, input: { level: 'warn', message: 'event', context: { adminActorId: 'spoof', privateValue: 'secret-value' } } })).toMatchObject({ ok: true });
  expect(events[0].ctx?.adminActorId).toBe('operator');
  expect(JSON.stringify(audit.events)).not.toContain('secret-value');
});
it('does not acknowledge successful flush when the sink rejects', async () => {
  const sink = Object.assign(() => {}, { flush: async () => { throw new Error('private storage error'); } });
  const { dispatcher } = setup(sink);
  const result = await dispatcher.dispatch({ operationId: 'logfn.sinks.flush', input: {}, context });
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('private storage error');
});
