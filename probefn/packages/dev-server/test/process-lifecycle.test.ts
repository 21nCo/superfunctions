import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import { DevServerManager } from '../src/dev-server-manager.js';

const deterministic = { enabled: true, viewport: { width: 1440, height: 900 }, locale: 'en-US', timezone: 'UTC', colorScheme: 'light' as const, reducedMotion: 'reduce' as const, animationPolicy: 'freeze' as const, networkIdleMs: 10 };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function fixture(code: string, run: (manager: DevServerManager, options: Parameters<DevServerManager['startSession']>[0], root: string, store: ArtifactStore) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probefn-lifecycle-'));
  const script = path.join(root, 'server.mjs');
  await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(path.join(root, 'pid'))}, String(process.pid));\n${code}`);
  const store = new ArtifactStore({ repoRoot: root });
  const manager = new DevServerManager({ repoRoot: root, artifactStore: store, shutdownTimeoutMs: 100 });
  try {
    await run(manager, { sessionId: 'session', runId: 'run', mode: 'mixed', browser: 'chromium', deterministic, devServer: { mode: 'spawn', name: 'web', command: `${quote(process.execPath)} ${quote(script)}`, cwd: '.', url: 'http://127.0.0.1:1', readyPattern: 'Local: (https?://\\S+)', timeoutMs: 200, envAllowlist: [] } }, root, store);
  } finally {
    const pid = await readFile(path.join(root, 'pid'), 'utf8').then(Number).catch(() => undefined);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
}
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };

describe.skipIf(process.platform === 'win32')('POSIX spawned-process ownership', () => {
  it('does not accept a readiness URL printed by a failed server', async () => {
    await fixture("console.error(\"SyntaxError near console.log('Local: http://127.0.0.1:1');\"); process.exit(23);", async (manager, options, root) => {
      await expect(manager.startSession(options)).rejects.toMatchObject({ code: 'E_DEVSERVER_EXIT_EARLY' });
      expect(gone(Number(await readFile(path.join(root, 'pid'), 'utf8')))).toBe(true);
      expect(JSON.parse(await readFile(path.join(root, '.artifacts/runs/run/session.json'), 'utf8')).status).toBe('failed');
    });
  });
  it('does not accept a matching banner while the HTTP endpoint is unreachable', async () => {
    await fixture("console.log('Local: http://127.0.0.1:1'); setInterval(() => {}, 1000);", async (manager, options, root) => {
      await expect(manager.startSession(options)).rejects.toMatchObject({ code: 'E_DEVSERVER_START_TIMEOUT' });
      expect(gone(Number(await readFile(path.join(root, 'pid'), 'utf8')))).toBe(true);
    });
  });
  it('waits through unavailable HTTP responses after the readiness banner', async () => {
    await fixture("import { createServer } from 'node:http'; let ready=false; setTimeout(()=>{ready=true;},250); const server=createServer((_req,res)=>{res.statusCode=ready?200:503;res.end('status');}); server.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+server.address().port));", async (manager, options) => {
      const started=await manager.startSession({...options,devServer:{...options.devServer,timeoutMs:2000}});
      const response=await fetch(started.resolvedUrl);
      expect(response.status).toBe(200);
      await response.body?.cancel();
      await manager.stopSession('session');
    });
  });
  it('aborts a hung spawned HTTP readiness probe when stopped', async () => {
    await fixture("import { createServer } from 'node:http'; const server=createServer(()=>writeFileSync('request-arrived','yes')); server.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+server.address().port));", async (manager, options, root) => {
      const starting=expect(manager.startSession({...options,devServer:{...options.devServer,timeoutMs:120000}})).rejects.toMatchObject({code:'E_SESSION_START_CANCELLED'});
      await vi.waitFor(async()=>expect(await readFile(path.join(root,'request-arrived'),'utf8')).toBe('yes'));
      await manager.stopSession('session');
      await starting;
      expect(gone(Number(await readFile(path.join(root,'pid'),'utf8')))).toBe(true);
    });
  });
  it('rejects sink failure after the banner while HTTP readiness is pending', async () => {
    await fixture("import { createServer } from 'node:http'; let ready=false; const server=createServer((_req,res)=>{res.statusCode=ready?200:503;res.end('status');}); server.listen(0,'127.0.0.1',()=>{console.log('Local: http://127.0.0.1:'+server.address().port);setTimeout(()=>console.log('unpersisted'),50);setTimeout(()=>{ready=true;},200);});", async (manager, options, root, store) => {
      const original=store.createEventSink.bind(store);
      vi.spyOn(store,'createEventSink').mockImplementation((...args)=>{
        const sink=original(...args);const append=sink.append.bind(sink);
        vi.spyOn(sink,'append').mockImplementation(async event=>{
          if((event as {line?:string}).line==='unpersisted')throw new Error('disk unavailable during readiness');
          return append(event);
        });return sink;
      });
      await expect(manager.startSession({...options,devServer:{...options.devServer,timeoutMs:2000}})).rejects.toThrow('disk unavailable during readiness');
      expect(gone(Number(await readFile(path.join(root,'pid'),'utf8')))).toBe(true);
      expect(JSON.parse(await readFile(path.join(root,'.artifacts/runs/run/session.json'),'utf8')).status).toBe('failed');
    });
  });
  it('rejects invalid readiness expressions before spawning a process', async () => {
    await fixture("setInterval(() => {}, 1000);", async (manager, options, root) => {
      await expect(manager.startSession({ ...options, devServer: { ...options.devServer, readyPattern: '[' } })).rejects.toMatchObject({ code: 'E_CONFIG_INVALID' });
      await expect(readFile(path.join(root, 'pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
  it('kills the owned descendant when readiness fails and SIGTERM is ignored', async () => {
    await fixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", async (manager, options, root) => {
      await expect(manager.startSession(options)).rejects.toMatchObject({ code: 'E_DEVSERVER_START_TIMEOUT' });
      expect(gone(Number(await readFile(path.join(root, 'pid'), 'utf8')))).toBe(true);
      const manifest = JSON.parse(await readFile(path.join(root, '.artifacts/runs/run/session.json'), 'utf8'));
      expect(manifest.status).toBe('failed');
    });
  });
  it('escalates normal stop for a ready server that ignores SIGTERM', async () => {
    await fixture("process.on('SIGTERM', () => {}); const http = await import('node:http'); const server = http.createServer((_req,res) => res.end('ready')); server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:'+server.address().port)); setInterval(() => {}, 1000);", async (manager, options, root) => {
      await manager.startSession({ ...options, devServer: { ...options.devServer, timeoutMs: 120000 } });
      await manager.stopSession('session');
      expect(gone(Number(await readFile(path.join(root, 'pid'), 'utf8')))).toBe(true);
    });
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('kills a surviving descendant after the shell and its stdio have closed (attempt %i)', async () => {
    const descendant = "import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync('descendant.pid', String(process.pid)); setInterval(() => {}, 1000);";
    await fixture(`import { spawn } from 'node:child_process'; import { existsSync } from 'node:fs';
spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
const ready = setInterval(async () => { if (existsSync('descendant.pid')) { clearInterval(ready); const http = await import('node:http'); const server = http.createServer((_req,res) => res.end('ready')); server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:'+server.address().port)); } }, 5);
setInterval(() => {}, 1000);`, async (manager, options, root) => {
      let pid: number | undefined;
      try {
        await manager.startSession({ ...options, devServer: { ...options.devServer, timeoutMs: 2000 } });
        pid = Number(await readFile(path.join(root, 'descendant.pid'), 'utf8'));
        await manager.stopSession('session');
        expect(gone(pid)).toBe(true);
      } finally {
        pid ??= await readFile(path.join(root, 'descendant.pid'), 'utf8').then(Number).catch(() => undefined);
        if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    });
  });
  it('waits for ESRCH after a transient permission error from the existence probe', async () => {
    await fixture("const http = await import('node:http'); const server = http.createServer((_req,res) => res.end('ready')); server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:'+server.address().port)); setInterval(() => {}, 1000);", async (manager, options, root) => {
      await manager.startSession({ ...options, devServer: { ...options.devServer, timeoutMs: 2000 } });
      const kill = process.kill.bind(process);
      let injected = false;
      const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid < 0 && signal === 0 && !injected) {
          injected = true;
          throw Object.assign(new Error('transient existence probe denial'), { code: 'EPERM' });
        }
        return kill(pid, signal);
      });
      try {
        await manager.stopSession('session');
        expect(injected).toBe(true);
        expect(gone(Number(await readFile(path.join(root, 'pid'), 'utf8')))).toBe(true);
      } finally { spy.mockRestore(); }
    });
  });
  it('surfaces persistent probe permission errors without releasing session ownership', async () => {
    await fixture("const http = await import('node:http'); const server = http.createServer((_req,res) => res.end('ready')); server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:'+server.address().port)); setInterval(() => {}, 1000);", async (manager, options) => {
      await manager.startSession({ ...options, devServer: { ...options.devServer, timeoutMs: 2000 } });
      const kill = process.kill.bind(process);
      let probes = 0;
      const denied = Object.assign(new Error('persistent existence probe denial'), { code: 'EPERM' });
      const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid < 0 && signal === 0) { probes++; throw denied; }
        return kill(pid, signal);
      });
      try {
        await expect(manager.stopSession('session')).rejects.toBe(denied);
        expect(probes).toBeGreaterThan(1);
      } finally { spy.mockRestore(); }
      // Only a later successful disappearance check can release this session.
      await manager.stopSession('session');
    });
  });
  it('joins and cancels startup when stop arrives during the first manifest write', async () => {
    await fixture("const http = await import('node:http'); const server = http.createServer((_req,res) => res.end('ready')); server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:'+server.address().port)); setInterval(() => {}, 1000);", async (manager, options, root, store) => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const write = store.writeRunManifest.bind(store);
      vi.spyOn(store, 'writeRunManifest').mockImplementationOnce(async (...args) => { await gate; return write(...args); });
      const starting = expect(manager.startSession(options)).rejects.toMatchObject({ code: 'E_SESSION_START_CANCELLED' });
      const stopping = manager.stopSession('session');
      release();
      await Promise.all([starting, stopping]);
      await expect(readFile(path.join(root, 'pid'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const manifest = JSON.parse(await readFile(path.join(root, '.artifacts/runs/run/session.json'), 'utf8'));
      expect(manifest.status).toBe('failed');
    });
  });
  it('cancels pending readiness and joins process cleanup on stop', async () => {
    await fixture("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", async (manager, options, root) => {
      const starting = expect(manager.startSession({ ...options, devServer: { ...options.devServer, timeoutMs: 120000 } })).rejects.toMatchObject({ code: 'E_SESSION_START_CANCELLED' });
      await vi.waitFor(async () => { expect(Number(await readFile(path.join(root, 'pid'), 'utf8'))).toBeGreaterThan(0); });
      const pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
      await manager.stopSession('session');
      await starting;
      expect(gone(pid)).toBe(true);
    });
  });
  it('retains ownership when startup cleanup cannot signal the process group', async () => {
    await fixture("setInterval(() => {}, 1000);", async (manager, options, root) => {
      const kill = process.kill.bind(process);
      let failSignal = true;
      const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid < 0 && signal === 'SIGTERM' && failSignal) {
          failSignal = false;
          throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
        }
        return kill(pid, signal);
      });
      try {
        await expect(manager.startSession(options)).rejects.toBeInstanceOf(AggregateError);
        const pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
        expect(gone(pid)).toBe(false);
        await manager.stopSession('session');
        expect(gone(pid)).toBe(true);
      } finally { spy.mockRestore(); }
    });
  });
  it('aborts an in-flight attach request when startup is stopped', async () => {
    await fixture('', async (manager, options) => {
      let requestArrived!: () => void;
      const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
      const server = createServer(() => { requestArrived(); });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      try {
        const starting = expect(manager.startSession({ ...options, devServer: { ...options.devServer, mode: 'attach', url: `http://127.0.0.1:${address.port}`, timeoutMs: 120000 } })).rejects.toMatchObject({ code: 'E_SESSION_START_CANCELLED' });
        await arrived;
        await manager.stopSession('session');
        await starting;
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  });
  it('rejects concurrent duplicate starts before the first manifest write finishes', async () => {
    await fixture("const http = await import('node:http'); const server = http.createServer((_req,res) => res.end('ready')); server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:'+server.address().port)); setInterval(() => {}, 1000);", async (manager, options) => {
      const starting = manager.startSession(options);
      await expect(manager.startSession(options)).rejects.toMatchObject({ code: 'E_SESSION_ALREADY_RUNNING' });
      await starting;
      await manager.stopSession('session');
    });
  });
  it('lets a successful start/stop process exit naturally with a long readiness deadline', async () => {
    await fixture("const http = await import('node:http'); const server = http.createServer((_req,res) => res.end('ready')); server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:'+server.address().port)); setInterval(() => {}, 1000);", async (_manager, options, root) => {
      const worker = path.join(root, 'worker.ts');
      const managerSource = fileURLToPath(new URL('../src/dev-server-manager.ts', import.meta.url));
      const storeSource = fileURLToPath(new URL('../../storage/src/index.ts', import.meta.url));
      await writeFile(worker, `import { DevServerManager } from ${JSON.stringify(managerSource)};
import { ArtifactStore } from ${JSON.stringify(storeSource)};
async function main() {
const root = ${JSON.stringify(root)};
const manager = new DevServerManager({repoRoot: root, artifactStore: new ArtifactStore({repoRoot: root}), shutdownTimeoutMs: 100});
const options = ${JSON.stringify(options)};
options.devServer.timeoutMs = 120000;
await manager.startSession(options);
await manager.stopSession('session');
console.log('closed');
}
main().catch(error => {console.error(error); process.exitCode = 1;});`);
      const jitiCli = path.join(path.dirname(createRequire(import.meta.url).resolve('jiti')), 'jiti-cli.mjs');
      const result = await promisify(execFile)(process.execPath, [jitiCli, worker], { timeout: 3000 });
      expect(result.stdout.trim()).toBe('closed');
    });
  });
  it('reports output persistence failure on stop and finalizes a failed manifest', async () => {
    await fixture("const http = await import('node:http'); const server = http.createServer((_req,res) => res.end('ready')); server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:'+server.address().port)); setTimeout(() => console.log('unpersisted'), 50); setInterval(() => {}, 1000);", async (manager, options, root, store) => {
      const original = store.createEventSink.bind(store);
      vi.spyOn(store, 'createEventSink').mockImplementation((...args) => {
        const sink = original(...args);
        const append = sink.append.bind(sink);
        vi.spyOn(sink, 'append').mockImplementation(async event => {
          if ((event as {line?: string}).line === 'unpersisted') throw new Error('disk unavailable');
          return append(event);
        });
        return sink;
      });
      await manager.startSession(options);
      await new Promise(resolve => setTimeout(resolve, 100));
      await expect(manager.stopSession('session')).rejects.toThrow('disk unavailable');
      expect(gone(Number(await readFile(path.join(root, 'pid'), 'utf8')))).toBe(true);
      const manifest = JSON.parse(await readFile(path.join(root, '.artifacts/runs/run/session.json'), 'utf8'));
      expect(manifest.status).toBe('failed');
    });
  });
  it('drains all stderr lines on early exit before reporting failure', async () => {
    await fixture("process.stderr.write(Array.from({length: 200}, (_,i) => 'failure '+i+' 😀').join('\\n')+'\\n', () => process.exit(23));", async (manager, options, root) => {
      await expect(manager.startSession(options)).rejects.toMatchObject({ code: 'E_DEVSERVER_EXIT_EARLY' });
      const events = (await readFile(path.join(root, '.artifacts/runs/run/devserver/stderr.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(events).toHaveLength(200);
      expect(events[199].line).toBe('failure 199 😀');
    });
  });
});
