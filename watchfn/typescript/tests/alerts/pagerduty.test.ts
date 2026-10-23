import { pagerDutyRequest } from '../../src/alerts/channels/pagerduty';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { WatchFn } from '../../src/core/watch-fn';
import { getWatchFnSchema } from '../../src/storage/schema';
import { getAlertSchema } from '../../src/alerts/schema';
const watches: WatchFn[] = [], databases: Kysely<any>[] = [], directories: string[] = [], servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const watch of watches.splice(0)) { await watch.flush().catch(() => {}); await watch.stop().catch(() => {}); }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  for (const db of databases.splice(0)) await db.destroy();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function connect(filename: string) {
  const native = new Database(filename); native.pragma('journal_mode = WAL');
  const sql = new Kysely<any>({ dialect: new SqliteDialect({ database: native }) }); databases.push(sql);
  return { sql, adapter: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(Object.keys({ ...getWatchFnSchema(), ...getAlertSchema() }).map(key => [key, key])) }) };
}
async function setup(extra: any = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'watch-alert-public-')); directories.push(directory);
  const filename = join(directory, 'db.sqlite'); const connection = connect(filename);
  for (const [name, table] of Object.entries({ ...getWatchFnSchema(), ...getAlertSchema() })) {
    let migration = connection.sql.schema.createTable(name);
    for (const [field, options] of Object.entries(table.fields)) migration = migration.addColumn(field, options.type === 'number' ? 'integer' : 'text', column => field === 'id' ? column.primaryKey() : options.required ? column.notNull() : column);
    await migration.execute();
  }
  const create = () => { const watch = new WatchFn({ name: 'test', storage: 'database', database: connect(filename).adapter, infra: { enabled: false }, alerts: extra }); watches.push(watch); watch.start(); return watch; };
  return { watch: create(), create, sql: connection.sql };
}
const rule = { metric: 'latency', operator: 'gt' as const, threshold: 5, window: '5m' };

async function endpoint() {
  const received: any[] = [];
  const state = { drop: false, oversized: false, wrongKey: false, status: 202 };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()); received.push(body);
      if (state.drop) { request.socket.destroy(); return; }
      response.writeHead(state.status, { 'content-type': 'application/json' });
      response.end(state.oversized ? 'x'.repeat(4097) : JSON.stringify({ status: 'success', dedup_key: state.wrongKey ? 'wrong' : body.dedup_key }));
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { received, state, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/events` };
}
const definition = () => ({ name: 'slow', condition: rule, severity: 'warning' as const,
  channels: [{ type: 'pagerduty' as const, integrationKey: 'owned-secret-key', severity: 'critical' as const }] });
async function drain(watch: WatchFn) { for (let index = 0; index < 8; index++) await watch.alerts.processNotifications(); }

it('delivers ordered Events v2 lifecycle with stable incident identity across reopen and workers', async () => {
  const target = await endpoint(); const { watch, create, sql } = await setup({ pagerDutyEndpoint: target.url });
  const alert = await watch.alerts.create(definition());
  await watch.alerts.trigger(alert.id); await watch.alerts.acknowledge(alert.id, { acknowledgedBy: 'operator' }); await watch.alerts.resolve(alert.id, { resolvedBy: 'operator' });
  await watch.stop(); for (const db of databases.splice(0)) await db.destroy();
  const first = create(), second = create();
  await Promise.all([drain(first), drain(second)]);
  expect(target.received.map(value => value.event_action)).toEqual(['trigger', 'acknowledge', 'resolve']);
  expect(new Set(target.received.map(value => value.dedup_key)).size).toBe(1);
  expect(target.received[0].payload).toEqual({ summary: 'slow', source: 'test', severity: 'critical', custom_details: { alertId: alert.id, description: '' } });
  expect((await first.alerts.get(alert.id)).pendingNotifications).toBe(0);
  expect((await first.alerts.notifications()).map(value => value.outcome)).toEqual(['delivered', 'delivered', 'delivered']);
  expect(JSON.stringify(await first.alerts.list())).not.toContain('owned-secret-key');
  // Inspect through a live independent adapter after all original handles closed.
  const internal = first.alerts as any;
  const rows = await internal.db.findMany({ model: 'watchfn_alert_outbox' });
  expect(JSON.stringify(rows)).not.toContain('owned-secret-key');
});

it('parks a lost trigger response and blocks successors until verified delivered reconciliation', async () => {
  const target = await endpoint(); target.state.drop = true;
  const { watch, create } = await setup({ pagerDutyEndpoint: target.url });
  const alert = await watch.alerts.create(definition());
  await watch.alerts.trigger(alert.id); await watch.alerts.acknowledge(alert.id, { acknowledgedBy: 'operator' }); await watch.alerts.resolve(alert.id, { resolvedBy: 'operator' });
  await drain(watch);
  const jobs = await watch.alerts.notifications(), trigger = jobs.find(value => value.event === 'triggered')!;
  expect(trigger).toMatchObject({ outcome: 'unknown', attempts: 1 });
  expect(target.received.map(value => value.event_action)).toEqual(['trigger']);
  expect((await watch.alerts.get(alert.id)).pendingNotifications).toBe(3);
  const reopened = create(); target.state.drop = false; await drain(reopened);
  expect(target.received).toHaveLength(1);
  await reopened.alerts.reconcileNotification(trigger.id, { outcome: 'delivered', actor: 'operator', reason: 'Independent PagerDuty acceptance verification' });
  await drain(reopened);
  expect(target.received.map(value => value.event_action)).toEqual(['trigger', 'acknowledge', 'resolve']);
  expect((await reopened.alerts.get(alert.id)).pendingNotifications).toBe(0);
});

it('orders the next episode behind prior resolution with a new dedup key and fences route edits', async () => {
  const target = await endpoint(); const { watch } = await setup({ pagerDutyEndpoint: target.url });
  const alert = await watch.alerts.create(definition());
  await watch.alerts.trigger(alert.id); await watch.alerts.resolve(alert.id, { resolvedBy: 'operator' });
  await expect(watch.alerts.update(alert.id, { ...definition(), channels: [] })).rejects.toThrow('obligations');
  await watch.alerts.trigger(alert.id); await drain(watch);
  expect(target.received.map(value => value.event_action)).toEqual(['trigger', 'resolve', 'trigger']);
  expect(target.received[0].dedup_key).toBe(target.received[1].dedup_key);
  expect(target.received[2].dedup_key).not.toBe(target.received[0].dedup_key);
  await expect(watch.alerts.update(alert.id, { ...definition(), channels: [] })).rejects.toThrow('obligations');
  await watch.alerts.resolve(alert.id, { resolvedBy: 'operator' }); await drain(watch);
  expect((await watch.alerts.update(alert.id, { ...definition(), channels: [] })).channels).toEqual([]);
});

it.each(['oversized', 'wrongKey'] as const)('does not acknowledge malformed %s receipt or replay it', async mode => {
  const target = await endpoint(); target.state[mode] = true;
  const { watch } = await setup({ pagerDutyEndpoint: target.url });
  const alert = await watch.alerts.create(definition()); await watch.alerts.trigger(alert.id); await drain(watch);
  expect(target.received).toHaveLength(1);
  expect(await watch.alerts.notifications()).toMatchObject([{ outcome: 'unknown', attempts: 1 }]);
  expect((await watch.alerts.get(alert.id)).pendingNotifications).toBe(1);
});

it('rejects legacy missing incident metadata before claiming or sending', async () => {
  const target = await endpoint(); const { watch, sql } = await setup({ pagerDutyEndpoint: target.url });
  const alert = await watch.alerts.create(definition()); await watch.alerts.trigger(alert.id);
  const job = await sql.selectFrom('watchfn_alert_outbox').selectAll().executeTakeFirstOrThrow();
  const payload = JSON.parse(job.payload); delete payload.pagerDuty;
  await sql.updateTable('watchfn_alert_outbox').set({ payload: JSON.stringify(payload) }).where('id', '=', job.id).execute();
  await expect(watch.alerts.processNotifications()).rejects.toThrow('metadata migration');
  expect(target.received).toHaveLength(0); expect(await watch.alerts.notifications()).toMatchObject([{ attempts: 0 }]);
});

it('fences foreign or absent ownership before lifecycle mutation', async () => {
  const { watch, sql } = await setup(); const alert = await watch.alerts.create({ name: 'fenced', condition: rule, channels: [] });
  await sql.updateTable('watchfn_alert_runtime').set({ protocol: 'python-v1' }).execute();
  for (const operation of [() => watch.alerts.trigger(alert.id), () => watch.alerts.update(alert.id, { name: 'changed', condition: rule, channels: [] }), () => watch.alerts.create({ name: 'new', condition: rule, channels: [] })]) await expect(operation()).rejects.toThrow('incompatible');
  await sql.deleteFrom('watchfn_alert_runtime').execute();
  await expect(watch.alerts.trigger(alert.id)).rejects.toThrow('explicit namespace ownership migration');
  expect((await watch.alerts.get(alert.id)).state).toBe('normal');
});

it('requires explicit bounded offline upgrade and preserves uncertain obligations', async () => {
  const { watch, sql } = await setup();
  const alert = await watch.alerts.create({ name: 'legacy', condition: rule, channels: [{ type: 'webhook', webhook: 'http://127.0.0.1:1/never-requested' }] });
  await watch.alerts.trigger(alert.id);
  await sql.updateTable('watchfn_alert_runtime').set({ protocol: 'ts-v1' }).execute();
  await sql.updateTable('watchfn_alert_outbox').set({ attempts: 1, state: 'sending', leaseToken: 'legacy-token' }).execute();
  await expect(watch.alerts.processNotifications()).rejects.toThrow('incompatible');
  expect(await watch.alerts.migrateStoppedLegacyNamespace({ limit: 1 })).toEqual({ alerts: 1, notifications: 1, parked: 1, protocol: 'ts-v2' });
  expect(await watch.alerts.notifications()).toMatchObject([{ outcome: 'unknown', attempts: 1 }]);
  expect((await watch.alerts.get(alert.id)).pendingNotifications).toBe(1);
});

it('rejects migration overflow and legacy PagerDuty without partial mutation', async () => {
  const { watch, sql } = await setup();
  await watch.alerts.create({ name: 'one', condition: rule, channels: [] });
  const alert = await watch.alerts.create(definition()); await watch.alerts.trigger(alert.id);
  await sql.updateTable('watchfn_alert_runtime').set({ protocol: 'ts-v1' }).execute();
  await expect(watch.alerts.migrateStoppedLegacyNamespace({ limit: 1 })).rejects.toThrow('capacity');
  await expect(watch.alerts.migrateStoppedLegacyNamespace({ limit: 10 })).rejects.toThrow('incident migration');
  expect((await sql.selectFrom('watchfn_alert_runtime').selectAll().executeTakeFirstOrThrow()).protocol).toBe('ts-v1');
  expect(await watch.alerts.notifications()).toMatchObject([{ attempts: 0, outcome: 'pending' }]);
});

it('shares Python Events v2 wire vectors including Unicode incident identity', async () => {
  const cases = JSON.parse(await readFile(new URL('../../../python/tests/fixtures/pagerduty-golden.json', import.meta.url), 'utf8'));
  for (const value of cases) expect(pagerDutyRequest(value.namespace, value.notification, value.channel, value.metadata)).toEqual(value.expected);
});

it('retries a rolled-back SQLite body conflict without duplicating provider work', async () => {
  const target = await endpoint(); const { watch } = await setup({ pagerDutyEndpoint: target.url });
  const alert = await watch.alerts.create(definition()); await watch.alerts.trigger(alert.id);
  const manager = watch.alerts as any, original = manager.db.transaction.bind(manager.db);
  let injected = 0;
  manager.db.transaction = (action: any) => original((tx: any) => action(new Proxy(tx, { get(object, property) {
    if (property === 'updateMany') return async (params: any) => {
      const result = await object.updateMany(params);
      if (params.model === 'watchfn_alert_outbox' && injected++ === 0) throw Object.assign(new Error('owned body contention'), { code: 'SQLITE_BUSY' });
      return result;
    };
    const value = object[property]; return typeof value === 'function' ? value.bind(object) : value;
  } })));
  await watch.alerts.processNotifications();
  expect(injected).toBeGreaterThan(1); expect(target.received).toHaveLength(1);
  expect(await watch.alerts.notifications()).toMatchObject([{ attempts: 1, outcome: 'delivered' }]);
  expect((await watch.alerts.get(alert.id)).pendingNotifications).toBe(0);
});

it.each(['commit', 'rollback'] as const)('does not retry %s-stage SQLite failure', async stage => {
  const target = await endpoint(); const { watch } = await setup({ pagerDutyEndpoint: target.url });
  const alert = await watch.alerts.create(definition()); await watch.alerts.trigger(alert.id);
  const manager = watch.alerts as any, original = manager.db.transaction.bind(manager.db);
  let claimCalls = 0;
  const boundaryError = Object.assign(new Error('owned boundary failure'), { code: 'SQLITE_BUSY' });
  manager.db.transaction = async (action: any) => {
    let touched = false;
    try {
      const result = await original((tx: any) => action(new Proxy(tx, { get(object, property) {
        if (property === 'updateMany') return async (params: any) => {
          if (params.model === 'watchfn_alert_outbox') {
            touched = true; claimCalls++;
            if (stage === 'rollback') throw Object.assign(new Error('owned body failure'), { code: 'SQLITE_BUSY' });
          }
          return object.updateMany(params);
        };
        const value = object[property]; return typeof value === 'function' ? value.bind(object) : value;
      } })));
      if (touched) throw boundaryError; // Actual commit completed; outcome must not be replayed.
      return result;
    } catch (error) {
      if (touched && stage === 'rollback') throw boundaryError; // Rollback failure replaces the sentinel.
      throw error;
    }
  };
  await expect(watch.alerts.processNotifications()).rejects.toBe(boundaryError);
  expect(claimCalls).toBe(1); expect(target.received).toHaveLength(0);
  expect(await watch.alerts.notifications()).toMatchObject([{ attempts: stage === 'commit' ? 1 : 0 }]);
});

it('propagates repeated body contention after finite rollback retries', async () => {
  const { watch } = await setup(); const manager = watch.alerts as any;
  const original = manager.db.transaction.bind(manager.db); let calls = 0;
  manager.db.transaction = (action: any) => original((tx: any) => action(new Proxy(tx, { get(object, property) {
    if (property === 'findOne') return () => { calls++; throw Object.assign(new Error('owned exhausted contention'), { code: 'SQLITE_BUSY' }); };
    const value = object[property]; return typeof value === 'function' ? value.bind(object) : value;
  } })));
  await expect(watch.alerts.create({ name: 'bounded', condition: rule, channels: [] })).rejects.toThrow('owned exhausted contention');
  expect(calls).toBeGreaterThanOrEqual(1); expect(calls).toBeLessThanOrEqual(3);
});

it('serializes concurrent claims on the default shared memory adapter without rollback loss', async () => {
  const { memoryAdapter } = await import('@superfunctions/db/adapters/memory');
  const target = await endpoint(); const database = memoryAdapter();
  const create = () => { const watch = new WatchFn({ name: 'memory-shared', storage: 'database', database, infra: { enabled: false }, alerts: { pagerDutyEndpoint: target.url } }); watches.push(watch); watch.start(); return watch; };
  const first = create(), second = create();
  const [a, b] = await Promise.all([first.alerts.create(definition()), second.alerts.create({ ...definition(), name: 'second' })]);
  await Promise.all([first.alerts.trigger(a.id), second.alerts.trigger(b.id)]);
  await Promise.all([drain(first), drain(second)]);
  expect(target.received).toHaveLength(2);
  expect((await first.alerts.notifications()).map(job => job.outcome)).toEqual(['delivered', 'delivered']);
  expect((await first.alerts.list()).map(alert => alert.pendingNotifications)).toEqual([0, 0]);
});
