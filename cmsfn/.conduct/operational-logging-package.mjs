// Run against normally installed packages; this is a JavaScript boundary acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCmsfnServer } from '@cmsfn/server';
const require = createRequire(import.meta.url);
for (const create of [createCmsfnServer, require('@cmsfn/server').createCmsfnServer]) {
  const records = [];
  const server = create({ contentfn: { baseUrl: 'http://127.0.0.1:1' }, datasets: [], desk: { kind: 'divider' }, auth: { kind: 'custom' },
    logging: { sink: (_level, _message, meta) => { records.push(meta); } } });
  for (const [action, input] of [
    ['unknown', { succeeded: true }], ['session.login', { succeeded: 'false' }],
    ['session.login', { succeeded: true, token: 'secret' }], ['session.logout', { succeeded: true, password: 'secret' }],
    ['session.login', null], ['session.login', []], ['session.logout', { succeeded: true, subject: 'x'.repeat(513) }],
    ['session.login', Object.defineProperty({}, 'succeeded', { get() { throw new Error('private-accessor'); } })],
  ]) {
    assert.throws(() => server.reportSessionEvent(action, input), error => error instanceof TypeError && error.message === 'Invalid session report');
    assert.equal(records.length, 0);
  }
  server.reportSessionEvent('session.login', { succeeded: false });
  server.reportSessionEvent('session.logout', { subject: 'verified', succeeded: true });
  assert.deepEqual(records.filter(record => record.phase === 'result').map(({ action, outcome, code }) => ({ action, outcome, code })), [
    { action: 'session.login', outcome: 'failed', code: 'AUTH_REQUIRED' },
    { action: 'session.logout', outcome: 'succeeded', code: undefined },
  ]);
  assert.deepEqual(server.loggingStatus(), { failures: 0, pending: 0 });
  assert.doesNotMatch(JSON.stringify(records), /secret|private-accessor/);
}
console.log('Installed ESM/CJS session reporting validates JavaScript inputs before admission.');
