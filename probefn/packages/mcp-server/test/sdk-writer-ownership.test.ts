import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it.each(['stop', 'SIGKILL'] as const)('fences an independent raw writer until native MCP owner %s', async outcome => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'probe-native-sdk-owner-'));
  const app = createServer((_req, res) => res.end('ready'));
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  await writeFile(path.join(root, 'config.mjs'), `export default ${JSON.stringify({ devServers: { app: { mode: 'attach', name: 'app', url } } })}`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('packages/mcp-server/dist/index.js'), 'serve', '--stdio'], cwd: root, stderr: 'pipe' });
  let diagnostics = ''; transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const client = new Client({ name: 'native-sdk-fencing', version: '1' });
  const storage = path.resolve('packages/storage/dist/index.js');
  async function write(name: string) {
    const source = `import {ArtifactStore} from ${JSON.stringify(storage)}; const store=new ArtifactStore({repoRoot:${JSON.stringify(root)}}); try { await store.writeArtifact(${JSON.stringify(`.artifacts/runs/live/${name}.txt`)}, 'independent'); console.log(JSON.stringify({ok:true})); } catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); }`;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 5000 });
    return JSON.parse(result.stdout) as { ok: boolean; code?: string };
  }
  try {
    await client.connect(transport);
    const start = await client.callTool({ name: 'probefn_session_start', arguments: { configPath: 'config.mjs', sessionId: 'live', runId: 'live' } });
    expect(start.isError, JSON.stringify(start) + diagnostics).toBe(false);
    expect(await write('denied')).toEqual({ ok: false, code: 'E_SESSION_ALREADY_RUNNING' });
    await expect(readFile(path.join(root, '.artifacts/runs/live/denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const pid = transport.pid;
    expect(pid).not.toBeNull();
    if (outcome === 'stop') {
      const stopped = await client.callTool({ name: 'probefn_session_stop', arguments: { sessionId: 'live' } });
      expect(stopped.isError, JSON.stringify(stopped)).toBe(false);
    } else {
      process.kill(pid!, 'SIGKILL');
      await expect.poll(() => { try { process.kill(pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }).toBe(true);
    }
    expect(await write('after')).toEqual({ ok: true });
    expect(await readFile(path.join(root, '.artifacts/runs/live/after.txt'), 'utf8')).toBe('independent');
    // Crash releases authority; it does not falsely finalize an interrupted session.
    const state = JSON.parse(await readFile(path.join(root, '.artifacts/session-state/live.json'), 'utf8'));
    expect(state.status).toBe(outcome === 'stop' ? 'completed' : 'running');
  } finally {
    await client.close(); await transport.close();
    app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
