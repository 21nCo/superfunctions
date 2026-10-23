import { spawn } from 'node:child_process';
import { removeOwnedBrowserContainer } from './lifecycle.js';
import { randomUUID } from 'node:crypto';
import { createServer, connect, type Socket } from 'node:net';
import { browserWorkerSource } from './worker.js';
import { createBrowserEgressProxy } from './egress-proxy.js';
import { denied } from '../../utils/destination-policy.js';
import { BrowseFnError } from '../../core/errors.js';

/** Trusted host configuration. Never accepted from HTTP request options. */
export interface BrowserIsolation {
  /** Locally provisioned image containing the matching Playwright/browser versions. No automatic pulls. */
  dockerImage: string;
}

/** Browser network namespace has only loopback; all egress crosses the checked proxy broker. */
export async function launchIsolatedBrowser(config: BrowserIsolation, provider: 'playwright' | 'puppeteer',
  engine: 'chromium' | 'firefox' | 'webkit', timeoutMs: number
): Promise<{ endpoint: string; assertAllowed(): void; close(): Promise<void> }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,250}$/.test(config.dockerImage)) throw denied();
  const name = `browsefn-${randomUUID()}`;
  const egress = await createBrowserEgressProxy({ timeoutMs });
  const peers = new Map<string, Socket>();
  let next = 0, input = '', stopped = false;
  let stopReason: Error | undefined;
  const unavailable = () => new BrowseFnError({ code: 'PROVIDER_UNAVAILABLE', message: 'Isolated browser worker is unavailable.' });
  let closePromise: Promise<void> | undefined;
  let resolveReady!: (path: string) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const child = spawn('docker', ['run', '--pull=never', '--rm', '--init', '--name', name,
    '--network=none', '--log-driver=none', '--ulimit=core=0', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
    '--memory=1g', '--memory-swap=1g', '--cpus=2', '--read-only', '--tmpfs=/tmp:rw,nosuid,size=268435456',
    '--shm-size=256m', '--user=1000:1000', '--env=HOME=/tmp', '-i', config.dockerImage,
    'node', '-e', browserWorkerSource], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Never forward image/browser stderr, which may contain request credentials.
  child.stderr.resume();
  const send = (frame: object) => {
    if (stopped) return;
    if (!child.stdin.write(JSON.stringify(frame) + '\n')) for (const socket of peers.values()) socket.pause();
  };
  child.stdin.on('drain', () => { for (const socket of peers.values()) socket.resume(); });
  child.stdin.on('error', () => rejectReady(unavailable()));
  const attach = (id: string, socket: Socket) => {
    if (stopped || peers.size >= 32 || peers.has(id)) { socket.destroy(); return; }
    peers.set(id, socket);
    socket.on('error', () => socket.destroy());
    socket.on('data', chunk => { for (let i = 0; i < chunk.length; i += 32768) send({ type: 'data', id, data: chunk.subarray(i, i + 32768).toString('base64') }); });
    socket.on('close', () => { peers.delete(id); send({ type: 'close', id }); });
  };
  const control = createServer(socket => { const id = `c${++next}`; attach(id, socket); if (peers.has(id)) send({ type: 'open', id }); });
  const close = () => closePromise ??= (async () => {
    stopped = true;
    clearTimeout(timer);
    for (const socket of peers.values()) socket.destroy();
    await new Promise<void>(resolve => control.close(() => resolve()));
    child.stdin.destroy();
    child.kill('SIGTERM');
    child.kill('SIGKILL');
    await egress.close();
    await removeOwnedBrowserContainer(name);
  })();
  const fail = () => { stopReason ??= unavailable(); rejectReady(stopReason); void close().catch(() => {}); };
  const timer = setTimeout(() => { stopReason = new BrowseFnError({ code: 'UPSTREAM_TIMEOUT', message: 'Isolated browser request timed out.' }); fail(); }, timeoutMs);
  child.on('error', fail);
  child.on('exit', () => { if (!stopped) fail(); });
  child.stdout.on('data', chunk => {
    input += chunk.toString();
    if (input.length > 262144 && !input.includes('\n')) return fail();
    let end: number;
    while ((end = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, end); input = input.slice(end + 1);
      if (line.length > 131072) return fail();
      try {
        const frame = JSON.parse(line);
        if (frame.type === 'ready' && typeof frame.path === 'string' && /^\/[a-zA-Z0-9/?=_-]+$/.test(frame.path)) resolveReady(frame.path);
        else if (frame.type === 'open' && /^e\d+$/.test(frame.id)) attach(frame.id, connect(egress.port, '127.0.0.1'));
        else if (frame.type === 'data' && typeof frame.data === 'string') {
          const socket = peers.get(frame.id);
          if (socket && !socket.write(Buffer.from(frame.data, 'base64'))) {
            child.stdout.pause(); socket.once('drain', () => child.stdout.resume()); socket.once('close', () => child.stdout.resume());
          }
        } else if (frame.type === 'close') peers.get(frame.id)?.destroy();
        else return fail();
      } catch { return fail(); }
    }
  });
  try {
    await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
    send({ type: 'init', provider, engine });
    const path = await ready;
    return { endpoint: `ws://127.0.0.1:${(control.address() as { port: number }).port}${path}`,
      assertAllowed() { egress.assertAllowed(); if (stopped) throw stopReason ?? unavailable(); }, close };
  } catch (error) { await close(); throw error; }
}
