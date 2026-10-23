import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'logfn-http-packed-'));
const npm = (args, cwd = temporary) => execFileSync(process.env.NPM_CLI ? process.execPath : 'npm', process.env.NPM_CLI ? [process.env.NPM_CLI, ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const tarballs = ['packages/observability', 'packages/http', 'logfn/typescript'].map(path => {
    const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], join(root, path)));
    return join(temporary, pack.filename);
  });
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs]);
  writeFileSync(join(temporary, 'consumer.mts'), `import {watchLogsRouter} from '@logfn/core/http/watch';
import type {Router, Middleware} from '@superfunctions/http';
import {requestLogger, type LogRequestContext} from '@logfn/core/http/shared';
const middleware: Middleware<LogRequestContext> = requestLogger(); void middleware;
const router: Router = watchLogsRouter({ingest: async events => { console.log(events[0]?.msg); }}); void router.handler;`);
  for (const mode of ['Node16', 'NodeNext']) execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'consumer.mts'], { cwd: temporary, stdio: 'pipe' });
  writeFileSync(join(temporary, 'smoke.mjs'), `import assert from 'node:assert/strict'; import {watchLogsRouter} from '@logfn/core/http/watch'; import {requestLogger} from '@logfn/core/http/shared'; import {createLogger} from '@logfn/core';
const logs=[]; const received=[]; const router=watchLogsRouter({basePath:'/api',ingest:async events=>received.push(events)});
router.use(requestLogger({logger:createLogger({name:'middleware',sinks:[batch=>logs.push(...batch)]})}));
const event={ts:new Date().toISOString(),name:'packed',msg:'ok',level:'info',version:'0'};
const response=await router.handler(new Request('http://local/api/watch/logs',{method:'POST',body:JSON.stringify({events:[event]})}));
assert.equal(response.status,202);assert.deepEqual(received,[[event]]);assert.equal(logs.length,2);assert.equal(logs[0].requestId,logs[1].requestId);
for(const [header,field] of [['x-request-id','requestId'],['x-trace-id','traceId'],['x-span-id','spanId']]) assert.equal(response.headers.get(header),logs[0][field]);
assert.equal((await router.handler(new Request('http://local/api/watch/logs'))).status,405);
console.log('packed shared HTTP',process.version);`);
  for (const version of ['18.18.0', '20.19.0', '22']) console.log(npm(['exec', '--yes', `--package=node@${version}`, '--', 'node', 'smoke.mjs']).trim());
  const audit = JSON.parse(npm(['audit', '--omit=dev', '--json']));
  assert.equal(audit.metadata.vulnerabilities.total, 0);
  console.log('shared HTTP declarations and runtime audit passed');
} finally { rmSync(temporary, { recursive: true, force: true }); }
