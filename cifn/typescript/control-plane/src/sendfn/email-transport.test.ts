import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { memoryAdapter, kyselyAdapter } from '@superfunctions/db/adapters';
import { wrapWithSchema } from '@superfunctions/db';
import { SendfnError } from '../../../../../sendfn/typescript/src/errors';
import { EmailService } from '../../../../../sendfn/typescript/src/email/service';
import { ResendAdapter } from '../../../../../sendfn/typescript/src/email/resend-adapter';
import { SendfnDb } from '../../../../../sendfn/typescript/src/database/sendfn-db';
import { getSendFnSchema } from '../../../../../sendfn/typescript/src/schema';
import { TemplateEngine, TemplateRegistry } from '../../../../../sendfn/typescript/src/templates/engine';
import { notificationDestination, parseNotificationConfig } from './sendfn-client.js';
import { deliverSendFnEmail } from './email-transport.js';
import { NotificationPublisher } from './outbox.js';
import { DatabaseStore } from '../store/database-store.js';
import { CIFN_STATE_TABLE, CIFN_SQLITE_SCHEMA } from '../store/database-schema.js';

const servers: Server[] = [];
const connections: Kysely<any>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  await Promise.all(connections.splice(0).map(db => db.destroy()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function serve(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture() {
  const providerKeys: string[] = []; const requests: any[] = [];
  let failProvider = false; let dropResponse = false; let mode = 'normal';
  const providerUrl = await serve(async (req, res) => {
    for await (const _chunk of req) { /* consume provider request */ }
    providerKeys.push(String(req.headers['idempotency-key']));
    res.writeHead(failProvider ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(failProvider ? { message: 'unavailable' } : { id: 'provider-message-1' }));
  });
  const db = new SendfnDb(wrapWithSchema(memoryAdapter(), getSendFnSchema()));
  const service = new EmailService(new ResendAdapter({ apiKey: 'provider-test-key', endpoint: providerUrl }), db,
    new TemplateEngine(), new TemplateRegistry(), { fromEmail: 'ci@example.test' } as any, { retryAttempts: 1 });
  const url = await serve(async (req, res) => {
    if (req.headers.authorization !== 'Bearer admin-test-secret') { res.writeHead(401); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const params = JSON.parse(Buffer.concat(chunks).toString()); requests.push(params);
    try {
      const data = await service.sendEmail(params);
      if (dropResponse) { dropResponse = false; req.socket.destroy(); return; }
      const returned = mode === 'wrong-key' ? { ...data, metadata: { idempotencyKey: 'other' } } : data;
      res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: returned }));
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(error instanceof SendfnError ? { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details } } : {})); }
  });
  return { db, providerKeys, requests, destination: { kind: 'sendfn-email' as const, url, userId: 'ci', to: 'owner@example.test', adminKey: 'admin-test-secret' },
    fail: () => { failProvider = true; }, drop: () => { dropResponse = true; }, wrongKey: () => { mode = 'wrong-key'; } };
}
const notification = { runId: 'run-1', status: 'success' as const, summary: 'Run completed.', pipelineRef: { repo: 'repo', ref: 'main' }, trigger: { type: 'workflow_dispatch' }, createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
it('replays response loss with the same real SendFn transaction and one provider call', async () => {
  const f = await fixture(); f.drop();
  expect(await deliverSendFnEmail(f.destination, notification, 'stable-event')).toEqual({ status: 'retry' });
  expect(await deliverSendFnEmail(f.destination, notification, 'stable-event')).toMatchObject({ status: 'accepted', transactionStatus: 'sent' });
  expect(f.providerKeys).toEqual(['stable-event']);
  expect(f.requests.map(r => r.idempotencyKey)).toEqual(['stable-event', 'stable-event']);
  f.wrongKey(); expect(await deliverSendFnEmail(f.destination, notification, 'stable-event')).toMatchObject({ status: 'reconciliation', reason: 'sendfn_invalid_receipt' });
});
it('does not acknowledge pending or failed SendFn transactions and never replaces their identity', async () => {
  const f = await fixture();
  const sent = await deliverSendFnEmail(f.destination, notification, 'pending-event');
  if (sent.status !== 'accepted') throw Error('Expected sent receipt');
  await f.db.updateEmailTransaction(sent.transactionId, { status: 'pending' });
  expect(await deliverSendFnEmail(f.destination, notification, 'pending-event')).toEqual({ status: 'retry' });
  expect(f.providerKeys).toHaveLength(1);
  f.fail(); expect(await deliverSendFnEmail(f.destination, notification, 'failed-event')).toEqual({ status: 'retry' });
  expect(await deliverSendFnEmail(f.destination, notification, 'failed-event')).toMatchObject({ status: 'reconciliation', reason: 'sendfn_failed' });
  expect(f.providerKeys).toEqual(['pending-event', 'failed-event']);
});
it('persists an uncertain email intent through SQLite close/reopen and stores a sanitized receipt', async () => {
  const f = await fixture(); const directory = await mkdtemp(join(tmpdir(), 'cifn-email-')); directories.push(directory);
  const path = join(directory, 'state.sqlite');
  async function open() {
    const native = new SQLite(path); native.pragma('journal_mode = WAL'); native.exec(CIFN_SQLITE_SCHEMA);
    const sql = new Kysely({ dialect: new SqliteDialect({ database: native }) }); connections.push(sql);
    const database = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { [CIFN_STATE_TABLE]: CIFN_STATE_TABLE } });
    return { sql, store: await DatabaseStore.open({ database, encryptionKey: Buffer.alloc(32, 19), namespace: 'email' }) };
  }
  let opened = await open();
  opened.store.configureNotifications({ enabled: true, emailTo: f.destination.to, sendFnEmailUrl: f.destination.url, sendFnAdminKey: f.destination.adminKey, sendFnUserId: f.destination.userId });
  const run = await opened.store.createRun({ trigger: { type: 'workflow_dispatch' }, pipelineRef: { repo: 'repo', ref: 'main' }, pipelineSpec: { name: 'email', on: { workflow_dispatch: {} }, jobs: { build: { 'runs-on': 'default', steps: [{ run: 'true' }] } } } });
  await opened.store.cancelRun(run.id); f.drop();
  await new NotificationPublisher(opened.store).tick();
  const pending = await opened.store.getNotificationState(run.id); expect(pending?.deliveredAt).toBeUndefined(); expect(pending?.attempts).toBe(1);
  await opened.sql.destroy(); connections.splice(connections.indexOf(opened.sql), 1);
  for (const file of await readdir(directory)) expect((await readFile(join(directory, file))).includes(Buffer.from(f.destination.adminKey))).toBe(false);
  opened = await open(); await new Promise(resolve => setTimeout(resolve, 1_050));
  await new NotificationPublisher(opened.store).tick();
  const done = await opened.store.getNotificationState(run.id);
  expect(done).toMatchObject({ eventId: pending?.eventId, attempts: 2, emailReceipt: { status: 'sent' } }); expect(done?.deliveredAt).toBeTruthy();
  expect(JSON.stringify(done)).not.toContain(f.destination.adminKey);
  expect(f.providerKeys).toEqual([pending?.eventId]); expect(f.requests[0].text).toContain('cancellation');
  opened.store.configureNotifications({ enabled: true, emailTo: f.destination.to, sendFnEmailUrl: f.destination.url, sendFnAdminKey: f.destination.adminKey, sendFnUserId: f.destination.userId });
  const failed = await opened.store.createRun({ trigger: { type: 'workflow_dispatch' }, pipelineRef: { repo: 'repo', ref: 'main' }, pipelineSpec: { name: 'failed', on: { workflow_dispatch: {} }, jobs: { build: { 'runs-on': 'default', steps: [{ run: 'true' }] } } } });
  await opened.store.cancelRun(failed.id); f.fail();
  const publisher = new NotificationPublisher(opened.store); await publisher.tick(); await new Promise(resolve => setTimeout(resolve, 1_050)); await publisher.tick();
  const parked = await opened.store.getNotificationState(failed.id); expect(parked?.reconciliation?.reason).toBe('sendfn_failed'); expect(parked?.deliveredAt).toBeUndefined();
  await opened.sql.destroy(); connections.splice(connections.indexOf(opened.sql), 1); opened = await open();
  await new NotificationPublisher(opened.store).tick(); expect(await opened.store.getNotificationState(failed.id)).toEqual(parked);
  expect(f.providerKeys).toHaveLength(2);

});

it('validates complete configuration and rejects ambiguous or unsafe destinations', () => {
  const config = parseNotificationConfig({ CIFN_NOTIFY_ON_RUN_COMPLETE: 'true', CIFN_NOTIFICATION_EMAIL_TO: 'owner@example.test', CIFN_SENDFN_EMAIL_URL: 'https://send.example.test/email', CIFN_SENDFN_ADMIN_KEY: 'key', CIFN_SENDFN_USER_ID: 'ci' });
  expect(notificationDestination(config)).toMatchObject({ kind: 'sendfn-email', userId: 'ci' });
  expect(() => notificationDestination({ ...config, webhookUrl: 'https://example.test' })).toThrow('Choose one');
  expect(() => notificationDestination({ ...config, sendFnAdminKey: undefined })).toThrow('real SendFn');
  expect(() => notificationDestination({ ...config, sendFnEmailUrl: 'https://user:secret@example.test/email' })).toThrow('without userinfo');
  expect(() => notificationDestination({ ...config, sendFnAdminKey: 'bad\r\nkey' })).toThrow('Invalid');
});
it('never acknowledges authentication failure, invalid success envelopes or oversized receipts', async () => {
  let status = 401; let body = '{}';
  const url = await serve(async (req, res) => { for await (const _chunk of req) {} res.writeHead(status); res.end(body); });
  const destination = { kind: 'sendfn-email' as const, url, userId: 'ci', to: 'owner@example.test', adminKey: 'secret' };
  expect(await deliverSendFnEmail(destination, notification, 'event')).toEqual({ status: 'reconciliation', reason: 'sendfn_request_rejected' });
  status = 200; body = JSON.stringify({ ok: true, data: { status: 'sent' } });
  expect(await deliverSendFnEmail(destination, notification, 'event')).toEqual({ status: 'reconciliation', reason: 'sendfn_invalid_receipt' });
  body = JSON.stringify({ data: 'x'.repeat(70_000) });
  expect(await deliverSendFnEmail(destination, notification, 'event')).toEqual({ status: 'retry' });
});
it('bounds a stalled SendFn response without acknowledging delivery', async () => {
  const url = await serve(async req => { for await (const _chunk of req) {} });
  const before = Date.now();
  expect(await deliverSendFnEmail({ kind: 'sendfn-email', url, userId: 'ci', to: 'owner@example.test', adminKey: 'key' }, notification, 'event')).toEqual({ status: 'retry' });
  expect(Date.now() - before).toBeLessThan(5_000);
}, 7_000);

it('parks actual SendFn suppression before transaction creation using the router error envelope', async () => {
  const f = await fixture();
  await f.db.addToSuppressionList({ email: f.destination.to, reason: 'manual', source: 'test' } as any);
  expect(await deliverSendFnEmail(f.destination, notification, 'suppressed-event')).toEqual({ status: 'reconciliation', reason: 'sendfn_suppressed' });
  expect(f.providerKeys).toHaveLength(0);
  expect(await f.db.findEmailTransactions({ userId: 'ci' })).toHaveLength(0);
});
it('retains retry for unrecognized, mismatched, malformed and oversized error envelopes', async () => {
  let body = '{}';
  const url = await serve(async (req, res) => { for await (const _chunk of req) {} res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(body); });
  const destination = { kind: 'sendfn-email' as const, url, userId: 'ci', to: 'owner@example.test', adminKey: 'secret' };
  for (const error of [
    { code: 'SENDFN_SUPPRESSED', retryable: false },
    { code: 'SENDFN_SUPPRESSED', retryable: false, details: { recipient: 'other@example.test' } },
    { code: 'SENDFN_SUPPRESSED', retryable: true, details: { recipient: destination.to } },
    { code: 'UNRELATED', retryable: false, details: { recipient: destination.to } },
  ]) {
    body = JSON.stringify({ ok: false, error });
    expect(await deliverSendFnEmail(destination, notification, 'event')).toEqual({ status: 'retry' });
  }
  for (const value of ['not-json', JSON.stringify({ error: 'x'.repeat(70_000) })]) {
    body = value; expect(await deliverSendFnEmail(destination, notification, 'event')).toEqual({ status: 'retry' });
  }
});
