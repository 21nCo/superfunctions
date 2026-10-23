import { afterEach, expect, it, vi } from 'vitest';
import type { AlertHost } from '../../src/alerts/alert-manager';
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
  return { watch: create(), create };
}
const rule = { metric: 'latency', operator: 'gt' as const, threshold: 5, window: '5m' };
async function observe(watch: WatchFn, value: number, timestamp = Date.now()) { await watch.ingest([{ type: 'metric', name: 'latency', value, timestamp }]); }
async function endpoint(status = 200) {
  const received: any[] = [];
  const server = createServer((request, response) => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => { received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); response.writeHead(status); response.end(); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { received, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/secret-token` };
}
it('evaluates public stored metrics and persists lifecycle, notes and outbox across reopen', async () => {
  const { watch, create } = await setup(); const target = await endpoint(); const now = Date.now();
  const alert = await watch.alerts.create({ name: 'slow', condition: rule, channels: [{ type: 'webhook', webhook: target.url }], autoResolve: { enabled: true, condition: { ...rule, operator: 'lt', threshold: 2, window: '1s' } } });
  expect(JSON.stringify(alert)).not.toContain('secret-token');
  await observe(watch, 10, now); const triggered = await watch.alerts.evaluate({ now });
  expect(triggered.results[0].alert.state).toBe('triggered');
  expect(target.received).toHaveLength(0);
  await watch.alerts.addNote(alert.id, { content: 'Investigating', createdBy: 'operator' });
  await watch.alerts.acknowledge(alert.id, { acknowledgedBy: 'operator' });
  const reopened = create(); expect((await reopened.alerts.get(alert.id)).state).toBe('acknowledged');
  expect((await reopened.alerts.get(alert.id)).notes).toHaveLength(1);
  await reopened.alerts.processNotifications(); expect(target.received).toHaveLength(2);
  expect(target.received[0].headers['idempotency-key']).toBeTruthy();
  await reopened.alerts.evaluate({ now: now + 10000 }); // Missing recovery observations must not resolve.
  expect((await reopened.alerts.get(alert.id)).state).toBe('acknowledged');
  await observe(reopened, 1, now + 20000); await reopened.alerts.evaluate({ now: now + 20000 });
  expect((await reopened.alerts.get(alert.id)).state).toBe('resolved');
  expect(JSON.stringify(await reopened.alerts.notifications())).not.toContain('secret-token');
});
it('keeps failed deliveries durable and bounded without exposing provider secrets', async () => {
  const { watch, create } = await setup({ maxAttempts: 1, maxPendingPerAlert: 1 }); const target = await endpoint(500);
  const alert = await watch.alerts.create({ name: 'failed', condition: rule, channels: [{ type: 'webhook', webhook: target.url }] });
  await watch.alerts.trigger(alert.id); await watch.alerts.processNotifications();
  const reopened = create(); const jobs = await reopened.alerts.notifications(); expect(jobs[0].state).toBe('dead');
  await expect(reopened.alerts.resolve(alert.id, { resolvedBy: 'operator' })).rejects.toThrow('capacity');
  expect((await reopened.alerts.get(alert.id)).state).toBe('triggered');
  expect(await reopened.alerts.dismissNotification(jobs[0].id)).toBe(true);
  await reopened.alerts.resolve(alert.id, { resolvedBy: 'operator' });
  expect((await reopened.alerts.get(alert.id)).state).toBe('resolved');
});
it('errors on observation overflow without changing lifecycle or emitting jobs', async () => {
  const { watch } = await setup({ maxObservations: 1 });
  const alert = await watch.alerts.create({ name: 'bounded', condition: rule, channels: [] });
  await observe(watch, 10); await observe(watch, 20);
  await expect(watch.alerts.evaluate()).rejects.toThrow('capacity');
  expect((await watch.alerts.get(alert.id)).state).toBe('normal');
});
it('rejects unconfigured email and PagerDuty instead of claiming delivery', async () => {
  const { watch } = await setup();
  expect(() => watch.alerts.create({ name: 'email', condition: rule, channels: [{ type: 'email', recipients: ['team@example.test'] }] })).toThrow('configured sender');
  expect(() => watch.alerts.create({ name: 'pager', condition: rule, channels: [{ type: 'pagerduty', integrationKey: 'secret' }] })).toThrow('configured sender');
});
it('claims each persisted job once across concurrent managers', async () => {
  const { watch, create } = await setup(); const target = await endpoint();
  const alert = await watch.alerts.create({ name: 'concurrent', condition: rule, channels: [{ type: 'webhook', webhook: target.url }] });
  await watch.alerts.trigger(alert.id);
  const second = create(); await Promise.all([watch.alerts.processNotifications(), second.alerts.processNotifications()]);
  expect(target.received).toHaveLength(1); expect(await watch.alerts.notifications()).toEqual([]);
  expect((await second.alerts.get(alert.id)).pendingNotifications).toBe(0);
});
it('stop waits for admitted dispatch and rejects new evaluation', async () => {
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((_request, response) => { entered(); void released.then(() => response.end()); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { watch } = await setup();
  const alert = await watch.alerts.create({ name: 'drain', condition: rule, channels: [{ type: 'webhook', webhook: `http://127.0.0.1:${(server.address() as { port: number }).port}` }] });
  await watch.alerts.trigger(alert.id); const dispatch = watch.alerts.processNotifications(); await entering;
  let stopped = false; const stop = watch.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(stopped).toBe(false);
  await expect(watch.alerts.evaluate()).rejects.toThrow('unavailable');
  release(); await dispatch; await stop; expect(stopped).toBe(true);
});
it('retains the public memory-mode API without claiming restart durability', async () => {
  const watch = new WatchFn({ name: 'memory-alerts', infra: { enabled: false } }); watches.push(watch); watch.start();
  const alert = await watch.alerts.create({ name: 'memory', condition: rule, channels: [] });
  await observe(watch, 10); await watch.alerts.evaluate();
  expect((await watch.alerts.list({ status: 'triggered' }))[0].id).toBe(alert.id);
});
it('evaluates composite conditions against their own persisted metric windows', async () => {
  const { watch } = await setup(); const now = Date.now();
  const alert = await watch.alerts.create({ name: 'composite', channels: [], condition: { type: 'composite', operator: 'and', conditions: [rule, { metric: 'requests', operator: 'gt', threshold: 100, window: '1m' }] } });
  await observe(watch, 10, now); await watch.ingest([{ type: 'metric', name: 'requests', value: 200, timestamp: now - 120000 }]);
  expect((await watch.alerts.evaluate({ now })).results[0].observed).toBe(false);
  expect((await watch.alerts.get(alert.id)).state).toBe('normal');
  await watch.ingest([{ type: 'metric', name: 'requests', value: 200, timestamp: now }]);
  await watch.alerts.evaluate({ now }); expect((await watch.alerts.get(alert.id)).state).toBe('triggered');
});
it('requires real standalone email configuration and escapes rendered input', async () => {
  const { EmailChannel } = await import('../../src/alerts/channels/email');
  const input = { name: '<script>bad</script>', severity: 'warning', timestamp: Date.now(), runbook: 'javascript:alert(1)' };
  await expect(new EmailChannel({ from: 'watch@example.test' }).send(input, ['team@example.test'])).rejects.toThrow('configured');
  let html = '';
  await new EmailChannel({ from: 'watch@example.test', sender: async message => { html = message.html; } }).send(input, ['team@example.test']);
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('javascript:');
});
it('keeps event-only nontransactional adapters usable and rejects alert use clearly', async () => {
  const { memoryAdapter } = await import('@superfunctions/db/adapters/memory');
  const adapter = memoryAdapter();
  const restricted = { ...adapter, capabilities: { ...adapter.capabilities, transactions: { supported: false } } } as any;
  const watch = new WatchFn({ name: 'events-only', storage: 'database', database: restricted, infra: { enabled: false } }); watches.push(watch); watch.start();
  await observe(watch, 10); expect(await watch.query({ metric: 'latency' })).toHaveLength(1);
  expect(() => watch.alerts).toThrow('transactions');
});

it('replaces omitted definition fields instead of retaining an old recovery policy', async () => {
  const { watch, create } = await setup();
  const alert = await watch.alerts.create({ name: 'old', condition: rule, channels: [], description: 'removed description', tags: ['old'], runbook: 'https://old.example', severity: 'critical', autoResolve: { enabled: true, condition: { ...rule, operator: 'lt', threshold: 2 } } });
  await watch.alerts.trigger(alert.id);
  const updated = await watch.alerts.update(alert.id, { name: 'replacement', condition: rule, channels: [] });
  expect(updated).not.toHaveProperty('autoResolve');
  for (const field of ['description', 'tags', 'runbook', 'severity']) expect(updated).not.toHaveProperty(field);
  await observe(watch, 1); await watch.alerts.evaluate();
  expect((await create().alerts.get(alert.id)).state).toBe('triggered');
});
it('rejects a stale observation snapshot after a concurrent manual resolution', async () => {
  const { watch, create } = await setup(); const now = Date.now();
  const alert = await watch.alerts.create({ name: 'racing evaluation', condition: rule, channels: [] });
  await observe(watch, 10, now); await watch.alerts.trigger(alert.id);
  const host = Reflect.get(watch.alerts, 'host') as AlertHost;
  const original = host.observations;
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(host, 'observations').mockImplementation(async (...args) => {
    const observations = await original(...args); entered(); await released; return observations;
  });
  const evaluation = watch.alerts.evaluate({ now });
  await entering; const second = create(); await second.alerts.resolve(alert.id, { resolvedBy: 'operator' }); release();
  try { await expect(evaluation).rejects.toThrow('changed during evaluation'); }
  finally { spy.mockRestore(); }
  expect((await second.alerts.get(alert.id)).state).toBe('resolved');
});
it('does not treat a sender returning after its deadline as a successful delivery', async () => {
  const { watch } = await setup({ timeoutMs: 5, leaseMs: 105, maxAttempts: 1, emailSender: async (_notification: unknown, _channel: unknown, signal: AbortSignal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  } });
  const alert = await watch.alerts.create({ name: 'timed out', condition: rule, channels: [{ type: 'email', recipients: ['test@example.test'] }] });
  await watch.alerts.trigger(alert.id); await watch.alerts.processNotifications();
  expect(await watch.alerts.notifications()).toMatchObject([{ state: 'dead', attempts: 1 }]);
  expect(await watch.alerts.get(alert.id)).not.toHaveProperty('lastNotification');
});
it('fences a previous sender after another manager reclaims an expired notification lease', async () => {
  const deliveries: { id: string; release: () => void }[] = [];
  const { watch, create } = await setup({ timeoutMs: 10000, leaseMs: 10100, maxAttempts: 2, emailSender: async (notification: { id: string }) => {
    await new Promise<void>(resolve => deliveries.push({ id: notification.id, release: resolve }));
  } });
  const alert = await watch.alerts.create({ name: 'lease ownership', condition: rule, channels: [{ type: 'email', recipients: ['test@example.test'] }] });
  await watch.alerts.trigger(alert.id);
  const first = watch.alerts.processNotifications();
  let second: Promise<unknown> | undefined, clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10101);
    const reopened = create(); second = reopened.alerts.processNotifications();
    await vi.waitFor(() => expect(deliveries).toHaveLength(2));
    expect(deliveries[1].id).toBe(deliveries[0].id);
    deliveries[0].release(); await first;
    expect(await reopened.alerts.notifications()).toMatchObject([{ state: 'sending', attempts: 2 }]);
    expect(await watch.alerts.processNotifications()).toEqual({ processed: 0 });
    deliveries[1].release(); await second;
    expect(await reopened.alerts.notifications()).toEqual([]);
    expect((await reopened.alerts.get(alert.id)).pendingNotifications).toBe(0);
  } finally {
    for (const delivery of deliveries) delivery.release();
    await Promise.allSettled([first, ...(second ? [second] : [])]); clock?.mockRestore();
  }
});
it('exhausts expired claims durably and never starts another sender beyond maxAttempts', async () => {
  let entered = false, release!: () => void;
  const { watch, create } = await setup({ timeoutMs: 10000, leaseMs: 10100, maxAttempts: 1, emailSender: async () => {
    entered = true; await new Promise<void>(resolve => { release = resolve; });
  } });
  const alert = await watch.alerts.create({ name: 'expired attempt', condition: rule, channels: [{ type: 'email', recipients: ['test@example.test'] }] });
  await watch.alerts.trigger(alert.id); const dispatch = watch.alerts.processNotifications();
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10101);
    const reopened = create(); expect(await reopened.alerts.processNotifications()).toEqual({ processed: 0 });
    expect(await reopened.alerts.notifications()).toMatchObject([{ state: 'dead', attempts: 1 }]);
    release(); await dispatch;
    const jobs = await reopened.alerts.notifications(); expect(jobs).toMatchObject([{ state: 'dead', attempts: 1 }]);
    expect((await reopened.alerts.get(alert.id)).pendingNotifications).toBe(1);
    expect(await reopened.alerts.dismissNotification(jobs[0].id)).toBe(true);
    expect((await reopened.alerts.get(alert.id)).pendingNotifications).toBe(0);
  } finally { release?.(); await dispatch; clock?.mockRestore(); }
});
it.each(['database', 'hybrid'] as const)('does not silently create volatile alerts for unavailable %s storage', storage => {
  const watch = new WatchFn({ name: 'missing-durable-storage', storage, infra: { enabled: false } }); watches.push(watch);
  expect(() => watch.alerts).toThrow('Alert storage is unavailable');
});
it('snapshots admitted lifecycle inputs before database waits', async () => {
  const { watch } = await setup();
  const alert = await watch.alerts.create({ name: 'input snapshot', condition: rule, channels: [] });
  await watch.alerts.trigger(alert.id);
  const actor = { acknowledgedBy: 'original-actor' };
  const acknowledgement = watch.alerts.acknowledge(alert.id, actor); actor.acknowledgedBy = 'x'.repeat(10000);
  expect((await acknowledgement).acknowledgedBy).toBe('original-actor');
  const resolution = { resolvedBy: 'original-resolver' };
  const resolving = watch.alerts.resolve(alert.id, resolution); resolution.resolvedBy = '';
  expect((await resolving).resolvedBy).toBe('original-resolver');
  const note = { content: 'original-note', createdBy: 'note-author' };
  const noting = watch.alerts.addNote(alert.id, note); note.content = 'changed-after-admission';
  expect((await noting).notes[0].content).toBe('original-note');
  let received: unknown;
  watch.alerts.onTrigger((_alert, context) => { received = context.value; });
  const trigger = { value: 3 };
  const triggering = watch.alerts.trigger(alert.id, trigger); trigger.value = Infinity;
  await triggering; expect(received).toBe(3);
});
it('rejects an empty dead-letter id without deleting an unrelated notification', async () => {
  const { watch } = await setup({ maxAttempts: 1 }); const target = await endpoint(500);
  const alert = await watch.alerts.create({ name: 'dead-letter identity', condition: rule, channels: [{ type: 'webhook', webhook: target.url }] });
  await watch.alerts.trigger(alert.id); await watch.alerts.processNotifications();
  const jobs = await watch.alerts.notifications();
  await expect(Promise.resolve().then(() => watch.alerts.dismissNotification(''))).rejects.toThrow('Invalid notification id');
  expect(await watch.alerts.notifications()).toEqual(jobs);
  expect((await watch.alerts.get(alert.id)).pendingNotifications).toBe(1);
});
it('retains lifecycle and retry attempts after all SQLite connections close and reopen', async () => {
  const { watch, create } = await setup({ maxAttempts: 2 }); const target = await endpoint(500);
  const alert = await watch.alerts.create({ name: 'physical reopen', condition: rule, channels: [{ type: 'webhook', webhook: target.url }] });
  await watch.alerts.trigger(alert.id);
  await watch.alerts.addNote(alert.id, { content: 'Before shutdown', createdBy: 'operator' });
  await watch.alerts.processNotifications();
  const [pending] = await watch.alerts.notifications(); expect(pending).toMatchObject({ state: 'pending', attempts: 1 });
  await watch.stop();
  for (const db of databases.splice(0)) await db.destroy();
  const reopened = create();
  expect(await reopened.alerts.notifications()).toEqual([pending]);
  expect(await reopened.alerts.get(alert.id)).toMatchObject({ state: 'triggered', pendingNotifications: 1, notes: [{ content: 'Before shutdown' }] });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(pending.availableAt + 1);
  try { await reopened.alerts.processNotifications(); }
  finally { clock.mockRestore(); }
  expect(await reopened.alerts.notifications()).toMatchObject([{ id: pending.id, state: 'dead', attempts: 2 }]);
  expect(target.received).toHaveLength(2);
  expect(target.received[0].headers['idempotency-key']).toBe(target.received[1].headers['idempotency-key']);
});


it.each(['memory', 'database'])('selects same-metric precedence separately for each child window (%s)', async storage => {
  const watch = storage === 'database' ? (await setup()).watch : new WatchFn({ name: 'window', storage: 'memory', infra: { enabled: false } });
  if (storage === 'memory') { watches.push(watch); watch.start(); }
  const fixture = JSON.parse(await readFile(new URL('../../../python/tests/fixtures/alert-window-golden.json', import.meta.url), 'utf8'));
  const now = fixture.now;
  await watch.ingest(fixture.events);
  await watch.alerts.create({ name: 'windows', channels: [], condition: fixture.condition });
  expect((await watch.alerts.evaluate({ now })).results[0].matched).toBe(fixture.expected);
  await watch.ingest([fixture.invalidExact]);
  expect((await watch.alerts.evaluate({ now })).results[0].matched).toBe(fixture.expectedAfterInvalid);
});
