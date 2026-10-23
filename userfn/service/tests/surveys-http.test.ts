import { UserFnClient } from 'userfn';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql as query } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import type { AuthProvider } from '@superfunctions/auth';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUserFnService, getUserFnSchema, type SurveyPolicy } from '../src/index.js';

it('stores validated survey responses atomically across HTTP races, rolling boundaries, lost receipts and SQLite reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'userfn-surveys-'));
  let now = 10000; const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const connect = () => {
    const native = new Database(join(directory, 'state.sqlite')); native.pragma('busy_timeout = 0');
    const sql = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) });
    return { sql, adapter: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getUserFnSchema()).map(key => [key, key])) }) };
  };
  let first = connect(), second = connect();
  const auth: AuthProvider = { async authenticate(request) {
    const token = request.headers.get('authorization')!.slice(7); if (token === 'bad') return null;
    const [tenantId, actorId, actorType = 'user'] = token.split(':');
    return { id: actorId, type: 'session', subject: { tenantId, actorId, actorType: actorType as 'user' }, scopes: token.includes('no-scope') ? [] : ['userfn:surveys:write'] };
  } };
  let policy: SurveyPolicy | null = { enabled: true, perUser: 3, window: { limit: 2, durationMs: 1000 }, questions: [
    { id: 'score', type: 'nps', title: 'Score', required: true }, { id: 'text', type: 'text', title: 'Details' },
    { id: 'choice', type: 'choice', title: 'Choice', choices: [{ label: 'A', value: 'a' }] },
  ] };
  const options = { auth, surveys: { resolvePolicy: () => policy } };
  let services = [createUserFnService({ ...options, database: first.adapter }), createUserFnService({ ...options, database: second.adapter })];
  const lostReceipts = new Set(['ts-lost', 'py-lost']);
  let next = 0;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const response = await services[next++ % 2].router.handle(new Request('http://local' + incoming.url, { method: incoming.method, headers, body: Buffer.concat(chunks) }));
      const key = incoming.headers['idempotency-key'];
      if (typeof key === 'string' && lostReceipts.delete(key)) { outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  try {
    for (const table of Object.values(getUserFnSchema()).filter(table => table.modelName.startsWith('userfn_survey_'))) {
      let migration = first.sql.schema.createTable(table.modelName);
      for (const [name, field] of Object.entries(table.fields)) migration = migration.addColumn(name, field.type === 'number' ? 'integer' : 'text', column => name === 'id' ? column.primaryKey() : column.notNull());
      await migration.execute();
    }
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
    const answers = [{ questionId: 'score', value: 8 }];
    const send = (key: string, actor = 'tenant:user', body: unknown = { answers }, survey = 'survey') => fetch(`http://127.0.0.1:${address.port}/surveys/${survey}/responses`, { method: 'POST', headers: { authorization: 'Bearer ' + actor, 'idempotency-key': key }, body: JSON.stringify(body) });
    expect((await send('auth', 'bad')).status).toBe(401);
    expect((await send('scope', 'tenant:no-scope')).status).toBe(403);
    expect((await send('service', 'tenant:robot:service')).status).toBe(403);
    for (const body of [{ answers: [] }, { answers: [{ questionId: 'score', value: 11 }] }, { answers: [...answers, ...answers] }, { answers: [...answers, { questionId: 'choice', value: 'invalid' }] }, { answers, actorId: 'other' }, { answers, submittedAt: 0 }]) expect((await send('invalid', undefined, body)).status).toBe(400);
    const races = await Promise.all(Array.from({ length: 8 }, (_, i) => send('race-' + i)));
    expect(races.filter(response => response.status === 201)).toHaveLength(2);
    expect(races.filter(response => response.status === 429)).toHaveLength(6);
    const winning = races.findIndex(response => response.status === 201);
    const saved = await races[winning].json();
    expect(await (await send('race-' + winning)).json()).toEqual(saved);
    expect((await send('race-' + winning, undefined, { answers: [{ questionId: 'score', value: 7 }] })).status).toBe(409);
    expect((await send('race-' + winning, undefined, { answers }, 'different')).status).toBe(409);
    expect((await send('other-user', 'tenant:other')).status).toBe(201);
    expect((await send('other-tenant', 'different:user')).status).toBe(201);
    now = 10999; expect((await send('before-boundary')).status).toBe(429);
    now = 11000; expect((await send('at-boundary')).status).toBe(201);
    now = 12000; expect((await send('lifetime')).status).toBe(429);
    now = 9000; expect((await send('backwards')).status).toBe(503);
    now = 12000;
    const duplicate = await Promise.all(Array.from({ length: 6 }, () => send('same', 'tenant:duplicate').then(response => response.json())));
    expect(new Set(duplicate.map(value => value.id)).size).toBe(1);
    expect(duplicate.every(value => value.accepted)).toBe(true);
    await query`CREATE TRIGGER fail_survey_insert BEFORE INSERT ON userfn_survey_responses BEGIN SELECT RAISE(ABORT, 'failure'); END`.execute(first.sql);
    expect((await send('rollback', 'tenant:rollback')).status).toBe(503);
    await query`DROP TRIGGER fail_survey_insert`.execute(first.sql);
    policy = { ...policy!, perUser: 1 };
    expect((await send('rollback', 'tenant:rollback')).status).toBe(201);
    for (const limited of [{ perUser: 0 }, { window: { limit: 0, durationMs: 1000 } }]) {
      policy = { ...policy!, perUser: 3, ...limited };
      expect((await send('zero', 'tenant:zero')).status).toBe(429);
    }
    policy = { ...policy!, perUser: 3, window: { limit: 2, durationMs: 1000 } };
    const endpoint = `http://127.0.0.1:${address.port}`;
    const ts = new UserFnClient({ endpoint, apiKey: 'tenant:ts', surveyMaxAttempts: 3 });
    const tsReceipt = await ts.submitSurveyResponse('survey', answers, { idempotencyKey: 'ts-lost' });
    expect(tsReceipt.accepted).toBe(true);
    expect(await ts.submitSurveyResponse('survey', answers, { idempotencyKey: 'ts-lost' })).toEqual(tsReceipt);
    await ts.submitSurveyResponse('survey', answers, { idempotencyKey: 'ts-next' });
    await expect(ts.submitSurveyResponse('survey', answers, { idempotencyKey: 'ts-capped' })).rejects.toMatchObject({ status: 429 });
    await promisify(execFile)(process.env.USERFN_SURVEY_PYTHON ?? 'python3', ['-c', `
import asyncio, sys
from userfn import UserFnClient, UserFnOptions, SurveyResponseAnswer, SurveyDeliveryError
from userfn.types import Survey, SurveyCaps, CampaignTrigger
async def run():
    client = UserFnClient(UserFnOptions(api_key='tenant:python', endpoint=sys.argv[1]))
    client.identify('python')
    client.set_surveys([Survey(id='survey', questions=[], enabled=True, triggers=[CampaignTrigger(type='event')], caps=SurveyCaps(2))])
    answers = [SurveyResponseAnswer(question_id='score', value=8)]
    first = await client.submit_survey_response('survey', answers, idempotency_key='py-lost')
    assert first.accepted
    assert await client.submit_survey_response('survey', answers, idempotency_key='py-lost') == first
    assert len(client.get_eligible_surveys('event', 'any')) == 1
    await client.submit_survey_response('survey', answers, idempotency_key='py-next')
    assert client.get_eligible_surveys('event', 'any') == []
    client.identify('another-local-identity')
    assert len(client.get_eligible_surveys('event', 'any')) == 1
    try:
        await client.submit_survey_response('survey', answers, idempotency_key='py-capped')
        raise AssertionError('cap not enforced')
    except SurveyDeliveryError as error:
        assert error.status == 429
asyncio.run(run())
`, endpoint], { env: { ...process.env, PYTHONPATH: resolve('../python/src') } });
    expect(lostReceipts.size).toBe(0);
    policy = { ...policy!, window: undefined, enabled: false };
    expect((await send('new-disabled')).status).toBe(403);
    expect(await (await send('race-' + winning)).json()).toEqual(saved);
    policy = null;
    expect((await send('missing')).status).toBe(404);
    await first.adapter.close(); await second.adapter.close(); first = connect(); second = connect();
    services = [createUserFnService({ ...options, database: first.adapter }), createUserFnService({ ...options, database: second.adapter })];
    expect(await (await send('race-' + winning)).json()).toEqual(saved);
    const stored = await query<{ answers: string }>`SELECT answers FROM userfn_survey_responses WHERE id = ${saved.id}`.execute(first.sql);
    expect(JSON.parse(stored.rows[0].answers)).toEqual(answers);
    policy = { enabled: true, perUser: 10, questions: [{ id: 'score', type: 'nps', title: 'Score', required: true }], schedule: { startAt: 50000, endAt: 60000 } };
    now = 49999;
    expect((await send('scheduled', 'tenant:scheduled')).status).toBe(403);
    now = 50000;
    const scheduled = await send('scheduled', 'tenant:scheduled');
    expect(scheduled.status).toBe(201);
    const scheduledReceipt = await scheduled.json();
    now = 59999;
    expect((await send('inside', 'tenant:scheduled')).status).toBe(201);
    now = 60000;
    expect((await send('expired', 'tenant:scheduled')).status).toBe(403);
    expect(await (await send('scheduled', 'tenant:scheduled')).json()).toEqual(scheduledReceipt);
    const scheduledRows = await query<{ count: number }>`SELECT count(*) AS count FROM userfn_survey_responses WHERE actorId = 'scheduled'`.execute(first.sql);
    expect(scheduledRows.rows[0].count).toBe(2);
  } finally {
    clock.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await first.adapter.close(); await second.adapter.close(); await rm(directory, { recursive: true, force: true });
  }
}, 20000);
