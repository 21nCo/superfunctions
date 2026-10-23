import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogSpool, replayStartedLogSnapshot } from './log-spool.js';
import { executeRemoteShellJob } from './remote-runner.js';
import { LOG_RETENTION_MS, type LogPacket } from '@cifn/control-plane';
const paths: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), 'cifn-log-spool-')); paths.push(path); return path; };
const identity = { runId: 'run', dispatchId: 'dispatch', runnerId: 'runner', claimToken: 'claim', executionId: 'execution' };
afterEach(() => { vi.restoreAllMocks(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('real LogFn persists redacted stdout/stderr, keeps stable replay after lost ACK, and expires private spool', async () => {
  const path = directory(); const secret = 'secret-✓-one\nsecret-two';
  let spool = new LogSpool(path, identity);
  const result = await executeRemoteShellJob({ runId: 'run', jobKey: 'build', env: { TOKEN: secret }, jobSpec: { 'runs-on': 'default', steps: [{ run: 'printf "safe stdout\\n%s\\n" "$TOKEN"; printf "safe stderr\\n%s\\n" "$TOKEN" >&2' }] } }, undefined, spool);
  expect(result.status).toBe('success'); spool.seal();
  const packets: LogPacket[] = [];
  await expect(spool.deliver(async packet => { packets.push(packet); throw new Error('lost ACK'); })).rejects.toThrow('lost ACK');
  const first = JSON.stringify(packets[0]);
  spool = new LogSpool(path, identity);
  await spool.deliver(async packet => { packets.push(packet); return { status: packet.terminal ?? 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS }; });
  expect(JSON.stringify(packets[1])).toBe(first);
  const bytes = readdirSync(join(path, 'logs')).map(name => readFileSync(join(path, 'logs', name), 'utf8')).join('');
  for (const part of secret.split('\n')) expect(bytes).not.toContain(part);
  expect(bytes).toContain('safe stdout'); expect(bytes).toContain('safe stderr'); expect(bytes).toContain('***');
  expect(statSync(join(path, 'logs')).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(join(path, 'logs'))) expect(statSync(join(path, 'logs', name)).mode & 0o777).toBe(0o600);
  expect(() => new LogSpool(path, { ...identity, executionId: 'other' })).toThrow('identity');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LOG_RETENTION_MS + 1);
  await spool.deliver(async () => { throw new Error('expired records must not transmit'); });
  expect(readdirSync(join(path, 'logs')).map(name => readFileSync(join(path, 'logs', name), 'utf8')).join('')).not.toContain('safe stdout');
});

it('emits explicit truncation instead of an unsafe secret prefix on interrupted output', async () => {
  const path = directory(); const spool = new LogSpool(path, identity); const controller = new AbortController();
  const pending = executeRemoteShellJob({ runId: 'run', jobKey: 'build', env: { TOKEN: 'sensitive-prefix-and-tail' }, jobSpec: { 'runs-on': 'default', steps: [{ run: 'printf \"%s\" \"${TOKEN%-and-tail}\"; sleep 10' }] } }, controller.signal, spool, () => spool.markTruncated());
  setTimeout(() => controller.abort(), 100);
  await pending; spool.seal();
  const packets: LogPacket[] = [];
  await spool.deliver(async packet => { packets.push(packet); return { status: packet.terminal ?? 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS }; });
  expect(packets[packets.length - 1].terminal).toBe('truncated');
  expect(JSON.stringify(packets)).not.toContain('sensitive-prefix');
});

it('bounds Unicode batches and records job cap truncation without claiming complete', async () => {
  const spool = new LogSpool(directory(), identity);
  for (let i = 0; i < 20; i++) spool.appendLines('run', 'build', 'step-0', ['✓'.repeat(30000)]);
  spool.seal();
  const packets: LogPacket[] = [];
  await spool.deliver(async packet => { packets.push(packet); return { status: packet.terminal ?? 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS }; });
  expect(packets[packets.length - 1].terminal).toBe('truncated');
  expect(packets.reduce((total, packet) => total + Buffer.byteLength(JSON.stringify(packet.events)), 0)).toBeLessThanOrEqual(1024 * 1024);
  expect(JSON.stringify(packets)).not.toContain('\ufffd');
  for (const packet of packets) expect(Buffer.byteLength(JSON.stringify(packet.events))).toBeLessThanOrEqual(64 * 1024);
});

it('reports a spool write failure independently from successful shell execution', async () => {
  const path = directory(); const spool = new LogSpool(path, identity);
  chmodSync(join(path, 'logs'), 0o500);
  try {
    const result = await executeRemoteShellJob({ runId: 'run', jobKey: 'build', jobSpec: { 'runs-on': 'default', steps: [{ run: 'printf success' }] } }, undefined, spool);
    expect(result.status).toBe('success'); expect(spool.outcome()).toBe('failed');
  } finally { chmodSync(join(path, 'logs'), 0o700); }
  spool.seal(); const packets: LogPacket[] = [];
  await spool.deliver(async packet => { packets.push(packet); return { status: packet.terminal ?? 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS }; });
  expect(packets[packets.length - 1].terminal).toBe('failed');
});

it('bounds escaped control-character messages without false truncation', async () => {
  const spool = new LogSpool(directory(), identity);
  spool.appendLines('run', 'build', 'step-0', ['\u0000'.repeat(4096)]); spool.seal();
  const packets: LogPacket[] = [];
  await spool.deliver(async packet => { packets.push(packet); return { status: packet.terminal ?? 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS }; });
  expect(packets[packets.length - 1].terminal).toBe('complete');
  for (const packet of packets) expect(Buffer.byteLength(JSON.stringify(packet.events))).toBeLessThanOrEqual(64 * 1024);
});


it('retains packets appended while an earlier acknowledgement is in flight', async () => {
  const path = directory();
  const spool = new LogSpool(path, identity);
  spool.appendLines('run', 'job', 'step', ['first']);
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received: LogPacket[] = [];
  const delivery = spool.deliver(async packet => {
    received.push(packet);
    if (packet.sequence === 0) { entered(); await gate; }
    return { status: packet.terminal ?? 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS };
  });
  await ready;
  spool.appendLines('run', 'job', 'step', ['second']);
  release(); await delivery;
  spool.seal();
  const reopened = new LogSpool(path, identity);
  await reopened.deliver(async packet => {
    received.push(packet);
    return { status: packet.terminal ?? 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS };
  });
  expect(received.flatMap(packet => packet.events.map(event => event.msg))).toEqual(['first', 'second']);
  expect(received.map(packet => packet.sequence)).toEqual([0, 1, 2]);
  expect(received.at(-1)?.terminal).toBe('complete');
});


it('redacts split secrets and UTF-8 before a running shell is released', async () => {
  const path = directory();
  const gate = join(path, 'release');
  const spool = new LogSpool(path, identity);
  const original = spool.appendLines.bind(spool);
  let observed = false;
  spool.appendLines = (runId, jobKey, stepKey, lines) => {
    original(runId, jobKey, stepKey, lines);
    if (lines.includes('safe ✓ secret ***')) { observed = true; writeFileSync(gate, 'release'); }
  };
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const script = `const fs=require('fs');const text=Buffer.from('safe '+String.fromCodePoint(10003)+' secret '+process.env.TOKEN+'\\n');process.stdout.write(text.subarray(0,6));setTimeout(()=>process.stdout.write(text.subarray(6,15)),30);setTimeout(()=>process.stdout.write(text.subarray(15)),60);const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);process.exit(0)}},10);setTimeout(()=>process.exit(9),5000);`;
  const result = await executeRemoteShellJob({ runId: 'run', jobKey: 'job', env: { TOKEN: 'configured-sensitive-value' }, jobSpec: { 'runs-on': 'default', steps: [{ run: `${quote(process.execPath)} -e ${quote(script)}` }] } }, undefined, spool);
  expect(observed).toBe(true);
  expect(result.status).toBe('success');
  spool.seal();
  const events: string[] = [];
  await spool.deliver(async packet => { events.push(...packet.events.map(event => event.msg)); return { status: packet.terminal ?? 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS }; });
  expect(events.filter(line => line === 'safe ✓ secret ***')).toHaveLength(1);
  expect(events.join('\n')).not.toContain('configured-sensitive-value');
  expect(events.join('\n')).not.toContain('\ufffd');
}, 10_000);


it('replays a read-only snapshot without overwriting concurrent owner appends or acknowledgements', async () => {
  const path = directory(); const spool = new LogSpool(path, identity);
  spool.appendLines('run', 'job', 'step', ['first']);
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const replayed: LogPacket[] = [];
  const replay = replayStartedLogSnapshot(path, identity, async packet => {
    replayed.push(packet); entered(); await gate;
    return { status: 'pending', nextSequence: 2, expiresAt: Date.now() + LOG_RETENTION_MS };
  });
  await ready;
  spool.appendLines('run', 'job', 'step', ['second']);
  await spool.deliver(async packet => ({ status: 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS }));
  const file = join(path, 'logs', readdirSync(join(path, 'logs'))[0]);
  const before = readFileSync(file); const info = statSync(file);
  release(); await replay;
  expect(readFileSync(file).equals(before)).toBe(true); expect(statSync(file).mtimeMs).toBe(info.mtimeMs);
  expect(replayed.flatMap(packet => packet.events.map(event => event.msg))).toEqual(['first']);
  const reopened = new LogSpool(path, identity); reopened.seal();
  const sent: LogPacket[] = [];
  await reopened.deliver(async packet => { sent.push(packet); return { status: packet.terminal ?? 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS }; });
  expect(sent).toHaveLength(1); expect(sent[0].sequence).toBe(2); expect(sent[0].terminal).toBe('complete');
});

it('never creates, seals, acknowledges or expires a started snapshot on disk', async () => {
  const path = directory(); const send = vi.fn(async (packet: LogPacket) => ({ status: 'pending', nextSequence: packet.sequence + 1, expiresAt: Date.now() + LOG_RETENTION_MS }));
  await replayStartedLogSnapshot(path, identity, send); expect(readdirSync(path)).toEqual([]);
  const spool = new LogSpool(path, identity); spool.appendLines('run', 'job', 'step', ['safe']); spool.seal();
  const file = join(path, 'logs', readdirSync(join(path, 'logs'))[0]); const before = readFileSync(file);
  await replayStartedLogSnapshot(path, identity, send); await replayStartedLogSnapshot(path, identity, send);
  expect(send.mock.calls.map(([packet]) => packet.sequence)).toEqual([0, 0]);
  expect(send.mock.calls.every(([packet]) => !packet.terminal)).toBe(true);
  expect(readFileSync(file).equals(before)).toBe(true);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LOG_RETENTION_MS + 1);
  send.mockClear(); await replayStartedLogSnapshot(path, identity, send);
  expect(send).not.toHaveBeenCalled(); expect(readFileSync(file).equals(before)).toBe(true);
});

it.each(['identity', 'digest', 'sequence', 'bytes', 'incomplete', 'oversized'])('rejects %s snapshots before transport without modifying them', async mode => {
  const path = directory(); const spool = new LogSpool(path, identity); spool.appendLines('run', 'job', 'step', ['safe']);
  const file = join(path, 'logs', readdirSync(join(path, 'logs'))[0]);
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (mode === 'identity') value.identity.claimToken = 'sensitive-wrong-claim';
  if (mode === 'digest') value.packets[0].digest = '0'.repeat(64);
  if (mode === 'sequence') value.packets[0].sequence = 2;
  if (mode === 'bytes') value.bytes++;
  writeFileSync(file, mode === 'incomplete' ? '{"sensitive-token":' : mode === 'oversized' ? 'x'.repeat(3 * 1024 * 1024 + 1) : JSON.stringify(value));
  const before = readFileSync(file); const send = vi.fn();
  await expect(replayStartedLogSnapshot(path, identity, send)).rejects.toThrow(/Log spool/);
  expect(send).not.toHaveBeenCalled(); expect(readFileSync(file).equals(before)).toBe(true);
});
