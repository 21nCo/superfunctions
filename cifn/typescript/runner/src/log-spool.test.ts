import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogSpool } from './log-spool.js';
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
