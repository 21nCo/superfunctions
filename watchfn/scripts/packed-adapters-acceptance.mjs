/** Build WatchFn and shared packages first. Each adapter gets an isolated consumer. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'watchfn-adapters-packed-'));
const npm = (args, cwd) => execFileSync(process.env.NPM_CLI ? process.execPath : 'npm', process.env.NPM_CLI ? [process.env.NPM_CLI, ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
const frameworks = { express: 'express', fastify: 'fastify', hono: 'hono', next: 'next', sveltekit: '@sveltejs/kit' };
const bodies = {
  express: `const express = load('express'); const app = express(); app.use(express.json()); app.use(adapter.createExpressMiddleware(watch)); app.use(adapter.createExpressRouter(watch));
    const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    try { await verify(async key => fetch('http://127.0.0.1:'+server.address().port+'/ingest', init(key))); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }`,
  fastify: `const app = load('fastify')(); const hooks = adapter.createFastifyHooks(watch); for (const [name, hook] of Object.entries(hooks)) app.addHook(name, hook); await app.register(adapter.createFastifyPlugin(watch));
    try { await verify(async key => { const result = await app.inject({method:'POST',url:'/ingest',headers:init(key).headers,payload:init(key).body}); return {status:result.statusCode,json:async()=>result.json()}; }); }
    finally { await app.close(); }`,
  hono: `const {Hono} = load('hono'); const app = new Hono(); adapter.applyWatchFn(app, watch, {prefix:'/watch'}); await verify(key => app.request('http://local/watch/ingest',init(key)));`,
  next: `const handlers = adapter.createNextHandler(watch, {trackRequests:true}); await verify(key => { const request = new Request('http://local/ingest',init(key)); Object.defineProperty(request,'nextUrl',{value:new URL(request.url)}); return handlers.POST(request,{params:{}}); });`,
  sveltekit: `const handlers = adapter.createSvelteKitHandler(watch,{trackRequests:true}); await verify(key => { const request = new Request('http://local/ingest',init(key)); return handlers.POST({request,url:new URL(request.url),params:{},locals:{},getClientAddress:()=> '127.0.0.1'}); });`,
};
try {
  const pack = path => {
    const [result] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], join(root, path)));
    return join(temporary, result.filename);
  };
  const shared = ['packages/observability', 'packages/http', 'packages/db', 'watchfn/typescript'].map(pack);
  for (const [name, framework] of Object.entries(frameworks)) {
    const consumer = join(temporary, name); mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({private:true,type:'module'}));
    const version = JSON.parse(readFileSync(join(root,'node_modules',framework,'package.json'),'utf8')).version;
    npm(['install','--ignore-scripts','--no-audit','--no-fund',...shared,pack(`packages/http-${name}`),`${framework}@${version}`], consumer);
    for (const other of Object.values(frameworks).filter(item => item !== framework)) assert.equal(existsSync(join(consumer,'node_modules',other)),false,`${name} must not install unrelated ${other}`);
    npm(['install','--save-dev','--ignore-scripts','--no-audit','--no-fund','@types/node@20', ...(name === 'express' ? ['@types/express@4'] : [])], consumer);
    const helpers = { express: 'createExpressMiddleware', fastify: 'createFastifyHooks', hono: 'createHonoMiddleware', next: 'createNextHandler', sveltekit: 'createSvelteKitHandler' };
    const typed = `import {WatchFn} from '@watchfn/core'; import {${helpers[name]}} from '@watchfn/core/adapters/${name}';
export const watch = new WatchFn({name:'typed',storage:'memory'}); export const integration = ${helpers[name]}(watch);`;
    for (const extension of ['mts','cts']) writeFileSync(join(consumer, `consumer.${extension}`), typed);
    for (const mode of ['Node16','NodeNext']) execFileSync(process.execPath, [join(root,'node_modules/typescript/bin/tsc'),'--declaration','--emitDeclarationOnly','--strict','--target','ES2022','--module',mode,'--moduleResolution',mode,'consumer.mts','consumer.cts'], {cwd:consumer,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    console.log(`${name}: strict root-to-adapter declarations passed`);
    const test = `
async function check(WatchFn, adapter, load) {
  const watch = new WatchFn({name:'packed-${name}',storage:'memory',infra:{enabled:false},auth:{enabled:true,apiKey:'local-key'}}); watch.start();
  const event = {name:'integration.event',ts:'2026-10-20T00:00:00.000Z',msg:'complete envelope',traceId:'0123456789abcdef0123456789abcdef',ctx:{nested:true}};
  const init = key => ({method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({events:[event]})});
  async function verify(send) {
    assert.equal((await send('wrong')).status,401);
    const response = await send('local-key'); assert.equal(response.status,202); assert.deepEqual(await response.json(),{accepted:1});
    assert.deepEqual(await watch.query({metric:'integration.event'}),[event]);
  }
  try {
    ${bodies[name]}
    const tracked = await watch.query({metric:'http.request'}); assert.equal(tracked.length,2,'Each request should be tracked once');
    assert.deepEqual(tracked.map(item=>item.properties.statusCode),[401,202]);
  } finally { await watch.stop(); }
  console.log('packed ${name}', process.version);
}
`;
    writeFileSync(join(consumer,'smoke.mjs'), `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import {WatchFn} from '@watchfn/core'; import * as adapter from '@watchfn/core/adapters/${name}'; ${test}\nawait check(WatchFn,adapter,createRequire(import.meta.url));`);
    writeFileSync(join(consumer,'smoke.cjs'), `const assert=require('node:assert/strict'); const {WatchFn}=require('@watchfn/core'); const adapter=require('@watchfn/core/adapters/${name}'); ${test}\ncheck(WatchFn,adapter,require).catch(error=>{console.error(error);process.exitCode=1;});`);
    for (const file of ['smoke.mjs','smoke.cjs']) console.log(execFileSync(process.execPath,[file],{cwd:consumer,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30_000}).trim());
    console.log(`${name} isolated installation passed (${framework}@${version})`);
  }
  console.log('Five isolated adapter consumers passed ESM and synchronous CommonJS loading; no framework audit claim.');
} finally { rmSync(temporary,{recursive:true,force:true}); }
