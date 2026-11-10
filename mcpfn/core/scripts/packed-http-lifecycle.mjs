// Rebuild core first. Freshly install its tarball and exercise ESM/CJS HTTP boundaries.
// NODE18/NODE20 optionally add exact minimum-runtime executables; Node18 needs WebCrypto.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'mcp-packed-http-'));
const run = (command, args, cwd = temporary) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

async function verify(runtime) {
  const { McpFnRegistry, createMcpFnServer, structuredResult } = runtime;
  const request = (method, params, session, httpMethod = 'POST') => new Request('https://example.test/mcp', {
    method: httpMethod, headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) },
    ...(httpMethod === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) } : {}),
  });
  const init = async handler => {
    const response = await handler(request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'packed-http', version: '1' } }));
    assert.equal(response.status, 200); await response.text();
  };
  for (const mode of ['list', 'context', 'resource']) {
    const fail = () => { throw Object.assign(new Error('private backend information'), { code: 11000, data: { secret: 'private' } }); };
    const registry = new McpFnRegistry().register({ name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, handler: async () => structuredResult({ ok: true }) });
    if (mode === 'resource') registry.registerResource({ name: 'secret', uri: 'test://secret', read: fail });
    const server = createMcpFnServer({ info: { name: 'error-probe', version: '1' }, registry,
      ...(mode === 'context' ? { context: fail } : {}),
      ...(mode === 'list' ? { clientProfiles: { profiles: [], resolveVerifiedIdentity: fail } } : {}),
    });
    try {
      const handler = await server.createWebStandardHandler({ enableJsonResponse: true, sessionIdGenerator: () => 'errors' });
      await init(handler);
      const response = await handler(request(mode === 'list' ? 'tools/list' : mode === 'context' ? 'tools/call' : 'resources/read', mode === 'context' ? { name: 'echo', arguments: {} } : mode === 'resource' ? { uri: 'test://secret' } : {}, 'errors'));
      const body = await response.json();
      assert.equal(body.error.code, -32603); assert.equal(body.error.message, 'Internal error');
      assert.equal(body.error.data, undefined); assert.ok(!JSON.stringify(body).includes('private'));
    } finally { await server.close(); }
  }
  for (const enableJsonResponse of [true, false]) {
    let attempts = 0;
    const server = createMcpFnServer({ info: { name: 'init-failure', version: '1' }, registry: new McpFnRegistry() });
    try {
      const handler = await server.createWebStandardHandler({ maxSessions: 1, enableJsonResponse, sessionIdGenerator: () => 'initial-' + attempts, onsessioninitialized: async () => { if (++attempts === 1) throw new Error('private database credentials'); } });
      const response = await handler(request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'packed-init', version: '1' } }));
      assert.equal(response.status, 500); assert.equal(response.headers.has('mcp-session-id'), false);
      assert.deepEqual(await response.json(), { jsonrpc: '2.0', error: { code: -32000, message: 'Session initialization failed' }, id: null });
      await init(handler);
    } finally { await server.close(); }
  }
  for (const mode of ['stateful-parent', 'stateless-parent', 'stateful-delete']) {
    let started, finish, signal;
    const began = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { finish = resolve; });
    const server = createMcpFnServer({ info: { name: 'close-probe', version: '1' }, registry: new McpFnRegistry().register({ name: 'slow', description: 'Slow', inputSchema: { type: 'object' }, handler: async (_args, _context, extra) => { signal = extra.signal; started(); await held; return structuredResult({ ok: true }); } }) });
    const stateful = mode !== 'stateless-parent';
    try {
      const handler = await server.createWebStandardHandler({ enableJsonResponse: true, ...(stateful ? { sessionIdGenerator: () => 'closing' } : {}) });
      if (stateful) await init(handler);
      const pending = handler(request('tools/call', { name: 'slow', arguments: {} }, stateful ? 'closing' : undefined));
      await began;
      if (mode === 'stateful-delete') {
        const deleted = await handler(request(undefined, undefined, 'closing', 'DELETE'));
        assert.equal(deleted.status, 200); await deleted.text();
      } else await server.close();
      assert.equal(signal.aborted, true);
      // A watchdog turns a never-settling SDK response into a bounded regression failure.
      let timer;
      try {
        const response = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP response did not settle after close')), 2000); })]);
        assert.equal(response.status, mode === 'stateful-delete' ? 404 : 503); await response.text();
      } finally { clearTimeout(timer); }
    } finally { finish(); await server.close(); }
  }
}

try {
  const tarball = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], packageDirectory))[0].filename;
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@mcpfn/core': `file:./${tarball}` } }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  writeFileSync(join(temporary, 'probe.mjs'), `import assert from 'node:assert/strict';\nimport {createRequire} from 'node:module';\nconst require=createRequire(import.meta.url);\nfor(const runtime of [await import('@mcpfn/core'),require('@mcpfn/core')]) await (${verify.toString()})(runtime);\nconsole.log(process.version+' ESM/CJS packed HTTP boundaries PASS');\n`);
  const targets = [{ executable: process.execPath, flags: [] }];
  if (process.env.NODE18) targets.push({ executable: process.env.NODE18, flags: ['--experimental-global-webcrypto'] });
  if (process.env.NODE20) targets.push({ executable: process.env.NODE20, flags: [] });
  for (const { executable, flags } of targets) console.log(run(executable, [...flags, join(temporary, 'probe.mjs')]));
} finally { rmSync(temporary, { recursive: true, force: true }); }
