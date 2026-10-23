import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { WatchFn } from '../../src/core/watch-fn';
import { getWatchFnSchema } from '../../src/storage/schema';
import { getAlertSchema, ALERT_OUTBOX } from '../../src/alerts/schema';
import * as email from '../../src/alerts/channels/email-ses';
import type { AlertEmailConfig } from '../../src/alerts/types';
const watches: WatchFn[] = [], databases: Kysely<any>[] = [], directories: string[] = [], servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const watch of watches.splice(0)) { await watch.flush().catch(() => {}); await watch.stop().catch(() => {}); }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  for (const db of databases.splice(0)) await db.destroy();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const rule = { metric: 'latency', operator: 'gt' as const, threshold: 5, window: '5m' };
const definition = { name: 'Alert\r\nInjected: no', description: '<script>private</script>', condition: rule, channels: [{ type: 'email' as const, recipients: ['operator@example.test'] }] };
async function setup() {
  let mode = 'success', sockets = 0;
  const requests: URLSearchParams[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push(new URLSearchParams(Buffer.concat(chunks).toString()));
      if (mode === 'drop') { request.socket.destroy(); return; }
      if (mode === 'hold') { response.writeHead(200); response.write('<SendEmailResponse>'); return; }
      if (mode === 'oversized') { response.writeHead(200); response.write('x'.repeat(1025)); return; }
      response.end(`<SendEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendEmailResult>${mode === 'empty' ? '' : '<MessageId>owned-receipt</MessageId>'}</SendEmailResult></SendEmailResponse>`);
    });
  });
  server.on('connection', socket => { sockets++; socket.once('close', () => { sockets--; }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config: AlertEmailConfig = { from: 'alerts@example.test', awsSes: { region: 'us-east-1', accessKeyId: 'owned-secret-key', secretAccessKey: 'owned-secret-value', endpoint: `http://127.0.0.1:${(server.address() as {port:number}).port}`, maxResponseBytes: 1024 } };
  const directory = await mkdtemp(join(tmpdir(), 'watch-email-')); directories.push(directory); const filename = join(directory, 'db.sqlite');
  const connect = () => { const native = new Database(filename); native.pragma('journal_mode=WAL'); const sql = new Kysely<any>({dialect:new SqliteDialect({database:native})}); databases.push(sql); return sql; };
  const sql = connect();
  const schema = {...getWatchFnSchema(), ...getAlertSchema()};
  for (const [name, table] of Object.entries(schema)) { let ddl = sql.schema.createTable(name); for (const [field, options] of Object.entries(table.fields)) ddl = ddl.addColumn(field, options.type === 'number' ? 'integer' : 'text', column => field === 'id' ? column.primaryKey() : options.required ? column.notNull() : column); await ddl.execute(); }
  const create = (configured = true, timeoutMs = 200) => { const watch = new WatchFn({name:'email-test',storage:'database',database:kyselyAdapter({db:connect(),dialect:'sqlite',schema:Object.fromEntries(Object.keys(schema).map(key=>[key,key]))}),infra:{enabled:false},alerts:{timeoutMs,leaseMs:3000,...(configured?{email:config}:{})}});watches.push(watch);watch.start();return watch; };
  return { create, sql, requests, config, mode: (value:string)=>{mode=value;}, sockets:()=>sockets };
}
it('delivers one real SES request across independent SQLite workers, survives reopen, and keeps credentials private', async () => {
  const f = await setup(), first=f.create(), second=f.create();
  const alert = await first.alerts.create(definition); await first.alerts.trigger(alert.id);
  expect(f.requests).toHaveLength(0);
  await Promise.all([first.alerts.processNotifications(), second.alerts.processNotifications()]);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].get('Action')).toBe('SendEmail');
  expect(f.requests[0].get('Message.Subject.Data')).not.toMatch(/[\r\n]/);
  expect(f.requests[0].get('Message.Body.Html.Data')).toContain('&lt;script&gt;private&lt;/script&gt;');
  await first.stop(); await second.stop(); const reopened=f.create();
  expect((await reopened.alerts.get(alert.id)).pendingNotifications).toBe(0);
  expect((await reopened.alerts.notifications())[0].outcome).toBe('delivered');
  expect(JSON.stringify(await reopened.alerts.list())).not.toContain('owned-secret');
  expect(JSON.stringify(await reopened.alerts.notifications())).not.toContain('operator@example.test');
});
it.each(['drop','empty','hold','oversized'])('parks %s outcome across reopen without replay and drains sockets', async mode => {
  const f=await setup(); f.mode(mode); const watch=f.create(); const alert=await watch.alerts.create(definition); await watch.alerts.trigger(alert.id);
  await watch.alerts.processNotifications(); await expect.poll(f.sockets).toBe(0);
  expect(f.requests).toHaveLength(1); expect((await watch.alerts.notifications())[0].outcome).toBe('unknown');
  await watch.stop(); const reopened=f.create(); await reopened.alerts.processNotifications();
  expect(f.requests).toHaveLength(1); expect((await reopened.alerts.get(alert.id)).pendingNotifications).toBe(1);
  expect((await reopened.alerts.pruneNotifications({completedBefore:Date.now()})).deleted).toBe(0);
});
it('does not claim when transport loading fails or host email configuration is absent', async () => {
  const f=await setup(), watch=f.create(); const alert=await watch.alerts.create(definition); await watch.alerts.trigger(alert.id);
  vi.spyOn(email,'loadSesProvider').mockRejectedValueOnce(new Error('missing optional transport'));
  await expect(watch.alerts.processNotifications()).rejects.toThrow('missing optional transport');
  const other=f.create(false); await other.alerts.processNotifications();
  const jobs=await f.sql.selectFrom(ALERT_OUTBOX).selectAll().execute(); expect(jobs[0].state).toBe('pending');expect(jobs[0].attempts).toBe(0);expect(f.requests).toHaveLength(0);
});
it('validates trusted config and built-in recipient limits before any send', async () => {
  const f=await setup(); expect(()=>email.validateEmailConfig({...f.config,from:'alerts@example.test\r\nBcc: other@example.test'})).toThrow();
  expect(()=>email.validateEmailConfig({...f.config,awsSes:{...f.config.awsSes,timeoutMs:0}})).toThrow();
  const watch=f.create();expect(()=>watch.alerts.create({...definition,channels:[{type:'email',recipients:Array(51).fill('a@example.test')}]})).toThrow();
  expect(()=>watch.alerts.create({...definition,channels:[{type:'email',recipients:['a@example.test\nBcc: x@example.test']}]})).toThrow();expect(f.requests).toHaveLength(0);
});

it('stop waits for in-flight transport timeout and closure', async () => {
  const f=await setup();f.mode('hold');const watch=f.create(true,1000);const alert=await watch.alerts.create(definition);await watch.alerts.trigger(alert.id);
  const dispatch=watch.alerts.processNotifications();await expect.poll(()=>f.requests.length).toBe(1);
  let stopped=false;const stopping=watch.stop().then(()=>{stopped=true;});
  await new Promise(resolve=>setImmediate(resolve));expect(stopped).toBe(false);
  await Promise.all([dispatch,stopping]);await expect.poll(f.sockets).toBe(0);
  expect((await f.create().alerts.notifications())[0].outcome).toBe('unknown');
});
it('surfaces cleanup failure and retains its claimed lease', async () => {
  const f=await setup(),watch=f.create();const alert=await watch.alerts.create(definition);await watch.alerts.trigger(alert.id);
  vi.spyOn(email,'sendSesEmail').mockRejectedValueOnce(new email.EmailCleanupError());
  await expect(watch.alerts.processNotifications()).rejects.toThrow('cleanup failed');
  const jobs=await f.sql.selectFrom(ALERT_OUTBOX).selectAll().execute();expect(jobs[0].state).toBe('sending');expect(jobs[0].attempts).toBe(1);expect(f.requests).toHaveLength(0);
});
