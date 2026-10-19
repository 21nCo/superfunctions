/** Build the shared closure and WatchFn before running this isolated consumer check. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'watchfn-packed-'));
const npm = (args, cwd = temporary) => execFileSync(process.env.NPM_CLI ? process.execPath : 'npm', process.env.NPM_CLI ? [process.env.NPM_CLI, ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const paths = ['packages/observability', 'packages/http', 'packages/db', 'watchfn/typescript'];
  const tarballs = paths.map(path => {
    const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], join(root, path)));
    return join(temporary, pack.filename);
  });
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs]);
  npm(['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '@types/node@18']);
  for (const name of ['express', 'fastify', 'hono', 'next', '@sveltejs/kit']) assert.equal(existsSync(join(temporary, 'node_modules', name)), false, `Core must not install ${name}`);
  const check = `
async function check(WatchFn) {
  const watch = new WatchFn({name:'packed',storage:'memory',infra:{enabled:false},auth:{enabled:true,apiKey:'local-key'}});
  watch.start();
  try {
    const event={ts:'2026-10-20T12:00:00.000Z',name:'packed',msg:'retained',traceId:'0123456789abcdef0123456789abcdef',ctx:{nested:true}};
    const request=(key)=>new Request('http://local/ingest',{method:'POST',headers:{authorization:'Bearer '+key},body:JSON.stringify({events:[event]})});
    assert.equal((await watch.httpRouter.handler(request('wrong'))).status,401);
    assert.equal((await watch.httpRouter.handler(request('local-key'))).status,202);
    assert.deepEqual(await watch.query({}),[event]);
    assert.deepEqual(await watch.query({timeRange:{from:event.ts,to:event.ts}}),[event]);
  } finally { await watch.stop(); }
  console.log('packed WatchFn',process.version);
}
`;
  writeFileSync(join(temporary, 'smoke.mjs'), `import assert from 'node:assert/strict'; import {WatchFn} from '@watchfn/core';${check}\nawait check(WatchFn);`);
  // This must remain a real synchronous require, not an async import workaround.
  writeFileSync(join(temporary, 'smoke.cjs'), `const assert=require('node:assert/strict'); const {WatchFn}=require('@watchfn/core');${check}\ncheck(WatchFn).catch(error=>{console.error(error);process.exitCode=1;});`);
  for (const version of ['18.18.0', '20.19.0', '22']) {
    for (const file of ['smoke.mjs', 'smoke.cjs']) console.log(npm(['exec', '--yes', `--package=node@${version}`, '--', 'node', file]).trim());
  }
  writeFileSync(join(temporary, 'consumer.mts'), `import {WatchFn} from '@watchfn/core';
const watch = new WatchFn({name:'typed',storage:'memory'}); void watch.httpRouter;`);
  writeFileSync(join(temporary, 'consumer.cts'), `import {WatchFn} from '@watchfn/core'; const watch = new WatchFn({name:'typed',storage:'memory'}); void watch.httpRouter;`);
  for (const mode of ['Node16', 'NodeNext']) execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'consumer.mts', 'consumer.cts'], { cwd: temporary, stdio: 'pipe', encoding: 'utf8' });
  // Use Node declarations contemporary with the promised compiler floor;
  // current @types/node releases can independently require a newer compiler.
  npm(['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '@types/node@18.16.19']);
  for (const mode of ['Node16', 'NodeNext']) npm(['exec', '--yes', '--package=typescript@5.0.4', '--', 'tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'consumer.mts', 'consumer.cts']);
  console.log('TypeScript 5.0.4 consumer declarations passed');
  let audit;
  try { audit = JSON.parse(npm(['audit', '--omit=dev', '--json'])); }
  catch (error) {
    if (!error.stdout) throw error;
    audit = JSON.parse(error.stdout);
  }
  console.log('production dependency audit', audit.metadata.vulnerabilities);
  for (const finding of Object.values(audit.vulnerabilities ?? {})) console.log(finding.name, finding.severity, 'fixAvailable:', finding.fixAvailable);
  assert.equal(audit.metadata.vulnerabilities.total, 0, 'Production dependency audit must be clear');
  console.log('WatchFn packed runtimes and runtime audit passed');
} finally { rmSync(temporary, { recursive: true, force: true }); }
