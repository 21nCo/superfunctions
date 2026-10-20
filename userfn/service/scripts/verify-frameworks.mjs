/** Fresh tarballs, React 18/19 SSR + Chrome, and a compiled Svelte 5 component. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserFnService } from '../dist/index.js';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
const { chromium } = await import(process.env.USERFN_PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'userfn-frameworks-'));
const npmCli = process.env.USERFN_NPM_CLI;
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
const npm = (args, cwd = directory) => npmCli ? run(process.execPath, [npmCli, ...args], cwd) : run('npm', args, cwd);
let browser, server; const exposures = []; let mode = 'normal';
try {
  const tarballs = [];
  for (const folder of ['watchfn/agents/browser', 'userfn/typescript']) {
    const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', directory], join(root, folder)));
    tarballs.push(join(directory, pack.filename));
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs]);
  await writeFile(join(directory, 'vanilla.mjs'), `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import {UserFnClient} from 'userfn'; import {flagStore} from 'userfn/svelte'; const require=createRequire(import.meta.url); assert.throws(()=>require.resolve('react')); assert.throws(()=>require.resolve('svelte')); const client=new UserFnClient({apiKey:'key',bootstrapFlags:{feature:true}}); assert.equal(client.getFlag('feature'),true); assert.equal(new (require('userfn').UserFnClient)({apiKey:'key'}).getFlag('missing'),false); let observed; flagStore(client,'feature').subscribe(value=>observed=value)(); assert.equal(observed,true);`);
  run(process.execPath, ['vanilla.mjs']);
  const keys = generateKeyPairSync('ed25519');
  const trustedKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const service = createUserFnService({ database: memoryAdapter(), flagConfigSigning: { privateKey: keys.privateKey, keyId: 'key-1' }, auth: { async authenticate(request) {
    return request.headers.get('authorization') === 'Bearer key' ? { id: 'key', type: 'api-key', subject: { actorId: 'fixture', actorType: 'api-key', tenantId: 'tenant' }, scopes: ['userfn:config:read', 'userfn:config:write'] } : null;
  } } });
  server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url === '/bundle.js') { outgoing.setHeader('content-type', 'text/javascript'); outgoing.end(await readFile(join(directory, 'bundle.js'))); return; }
      if (incoming.url === '/hydrate') { outgoing.end('<!doctype html><div id="react">' + await readFile(join(directory, 'hydration.html'), 'utf8') + '</div><div id="svelte"></div><script type="module" src="/bundle.js"></script>'); return; }
      if (incoming.url === '/') { outgoing.end('<!doctype html><div id="react"></div><div id="svelte"></div><script type="module" src="/bundle.js"></script>'); return; }
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      if (incoming.url === '/ingest') {
        assert.equal(incoming.headers.authorization, 'Bearer watch-key'); exposures.push(...JSON.parse(Buffer.concat(chunks)));
        outgoing.writeHead(202); outgoing.end('{"accepted":1}'); return;
      }
      const headers = new Headers(incoming.headers); if (mode === 'bad') headers.delete('if-none-match');
      const response = await service.router.handle(new Request('http://localhost' + incoming.url, { method: incoming.method, headers, ...(incoming.method === 'PUT' ? { body: Buffer.concat(chunks) } : {}) }));
      if (mode === 'bad' && incoming.method === 'GET') response.headers.set('x-userfn-signature', 'A'.repeat(86));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end('fixture failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const flags = [{ key: 'feature', enabled: true, defaultValue: false, variations: [{ id: 'paid', value: true }], rules: [{ id: 'paid-rule', variationId: 'paid', constraints: [{ id: 'plan', field: 'plan', operator: 'equals', value: 'paid' }] }] }];
  assert.equal((await fetch(endpoint + '/config/production', { method: 'PUT', headers: { authorization: 'Bearer key', 'content-type': 'application/json', 'if-none-match': '*' }, body: JSON.stringify({ flags, segments: [] }) })).status, 201);
  const options = { apiKey: 'key', endpoint, environment: 'production', bootstrapFlags: { feature: 'bootstrap' }, config: { tenantId: 'tenant', trustedKeys: { 'key-1': trustedKey }, allowInsecureHttp: true }, exposures: { endpoint: endpoint + '/ingest', apiKey: 'watch-key', app: 'framework-fixture', allowInsecureHttp: true } };
  browser = await chromium.launch({ headless: true, executablePath: process.env.USERFN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const results = [];
  for (const major of [18, 19]) {
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', `react@${major}`, `react-dom@${major}`, `@types/react@${major}`, `@types/react-dom@${major}`, 'typescript@5.6.3', 'esbuild@0.25', 'svelte@5']);
    await writeFile(join(directory, 'fixture.svelte'), `<script>export let store;</script><output id="svelte-value">{JSON.stringify($store)}</output>`);
    await writeFile(join(directory, 'compile.mjs'), `import{compile}from'svelte/compiler';import{readFileSync,writeFileSync}from'node:fs';const source=readFileSync('fixture.svelte','utf8');for(const generate of ['client','server'])writeFileSync('component-'+generate+'.mjs',compile(source,{filename:'fixture.svelte',generate}).js.code);`);
    run(process.execPath, ['compile.mjs']);
    await writeFile(join(directory, 'ssr.mjs'), `import assert from'node:assert/strict';import React from'react';import{renderToString}from'react-dom/server';import{writeFileSync}from'node:fs';import{render}from'svelte/server';import{createRequire}from'node:module';import{UserFnClient}from'userfn';import{UserFnProvider,useFlag}from'userfn/react';import{flagStore}from'userfn/svelte';import Component from'./component-server.mjs';const c=new UserFnClient(${JSON.stringify(options)});function View(){return React.createElement('output',{id:'react-value'},JSON.stringify(useFlag('feature')))}const html=renderToString(React.createElement(UserFnProvider,{client:c},React.createElement(View)));assert.match(html,/bootstrap/);writeFileSync('hydration.html',html);assert.match(render(Component,{props:{store:flagStore(c,'feature')}}).body,/bootstrap/);await c.flushExposures();c.setConsent({analytics:false,messaging:false});assert.equal(c.getFlag('feature'),'bootstrap');assert.equal(c.getConsent().analytics,false);const require=createRequire(import.meta.url);const C=require('userfn').UserFnClient;const hooks=require('userfn/react');const s=require('userfn/svelte');function V(){return React.createElement('b',null,String(hooks.useFlag('feature')))}assert.match(renderToString(React.createElement(hooks.UserFnProvider,{client:new C({apiKey:'key',bootstrapFlags:{feature:true}})},React.createElement(V))),/true/);let value;s.flagStore(new C({apiKey:'key'}),'missing').subscribe(v=>value=v)();assert.equal(value,false);console.log('React '+React.version+' and compiled Svelte SSR passed');`);
    const beforeSsr = exposures.length; process.stdout.write(run(process.execPath, ['ssr.mjs'])); assert.equal(exposures.length, beforeSsr);
    for (const extension of ['mts', 'cts']) {
      await writeFile(join(directory, 'consumer.' + extension), `import {UserFnClient,type FlagSnapshot} from'userfn';import{UserFnProvider,useFlag}from'userfn/react';import{flagStore}from'userfn/svelte';import{createElement}from'react';import type{Readable}from'svelte/store';const c=new UserFnClient({apiKey:'key'});c.setConsent({analytics:false,doNotTrack:true});const policy:import('userfn').ConsentState=c.getConsent();void policy;const o=c.observeFlag('x');const s:FlagSnapshot=o.getSnapshot();o.track(s);const v:Readable<import('userfn').FlagValue>=flagStore(c,'x');createElement(UserFnProvider,{client:c});function View(){return createElement('div',null,String(useFlag('x',false)))}void v;void View;`);
      process.stdout.write(run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'consumer.' + extension]));
    }
    await writeFile(join(directory, 'browser.mjs'), `import React from'react';import{createRoot,hydrateRoot}from'react-dom/client';import{mount,unmount}from'svelte';import{UserFnClient}from'userfn';import{UserFnProvider,useFlag}from'userfn/react';import{flagStore}from'userfn/svelte';import Component from'./component-client.mjs';globalThis.client=new UserFnClient(${JSON.stringify(options)});globalThis.renders=0;function View(){renders++;return React.createElement('output',{id:'react-value'},JSON.stringify(useFlag('feature')))}const tree=c=>React.createElement(React.StrictMode,null,React.createElement(UserFnProvider,{client:c},React.createElement(View)));const hydrating=location.pathname==='/hydrate';const root=hydrating?hydrateRoot(document.querySelector('#react'),tree(client)):createRoot(document.querySelector('#react'));globalThis.show=(c=client)=>root.render(tree(c));globalThis.suspend=()=>{function Abandoned(){useFlag('uncommitted');throw new Promise(()=>{})}root.render(React.createElement(React.StrictMode,null,React.createElement(UserFnProvider,{client},React.createElement(React.Suspense,{fallback:React.createElement('span',{id:'suspended'},'waiting')},React.createElement(Abandoned)))))};globalThis.remove=()=>root.unmount();globalThis.makeClient=()=>new UserFnClient(${JSON.stringify(options)});globalThis.mountSvelte=c=>{globalThis.component=mount(Component,{target:document.querySelector('#svelte'),props:{store:flagStore(c,'feature')}})};globalThis.removeSvelte=()=>unmount(component);if(!hydrating)show();globalThis.ready=true;`);
    run(join(directory, 'node_modules/.bin/esbuild'), ['browser.mjs', '--bundle', '--format=esm', '--platform=browser', '--conditions=browser', '--outfile=bundle.js']);
    const page = await browser.newPage(); const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message)); await page.goto(endpoint);
    await page.waitForFunction(() => globalThis.ready && document.querySelector('#react-value')?.textContent === '"bootstrap"');
    await page.evaluate(() => client.flushExposures()); assert.equal(exposures.length - beforeSsr, 1, 'StrictMode must not duplicate the initial committed selection');
    await page.evaluate(async () => { await client.refreshConfig(); }); await page.waitForFunction(() => document.querySelector('#react-value').textContent === 'false'); await page.evaluate(() => client.flushExposures());
    const before304 = exposures.length; assert.equal(await page.evaluate(() => client.refreshConfig()), false); await page.evaluate(() => client.flushExposures()); assert.equal(exposures.length, before304);
    await page.evaluate(() => client.identify('paid-person', { plan: 'paid' })); await page.waitForFunction(() => document.querySelector('#react-value').textContent === 'true'); await page.evaluate(() => client.flushExposures());
    assert.equal(exposures.at(-1).user.id, 'paid-person'); assert.equal(exposures.at(-1).properties.ruleId, 'paid-rule');
    await page.evaluate(() => client.reset()); await page.waitForFunction(() => document.querySelector('#react-value').textContent === 'false'); await page.evaluate(() => client.flushExposures());
    const beforeReturn = exposures.length; await page.evaluate(() => client.identify('paid-person', { plan: 'paid' })); await page.waitForFunction(() => document.querySelector('#react-value').textContent === 'true'); await page.evaluate(() => client.flushExposures()); assert.equal(exposures.length, beforeReturn + 1); assert.equal(exposures.at(-1).properties.ruleId, 'paid-rule');
    mode = 'bad'; const beforeBad = exposures.length; assert.equal(await page.evaluate(async () => { try { await client.refreshConfig(); return false; } catch { return true; } }), true); await page.evaluate(() => client.flushExposures()); assert.equal(exposures.length, beforeBad); assert.equal(await page.textContent('#react-value'), 'true'); mode = 'normal';
    await page.evaluate(() => client.setFlags([{key:'feature',enabled:true,defaultValue:'local',variations:[{id:'segment',value:'segment'}],rules:[{id:'segment-rule',segmentId:'segment',variationId:'segment'}]}])); await page.waitForFunction(() => document.querySelector('#react-value').textContent === '"local"'); await page.evaluate(() => client.flushExposures());
    await page.evaluate(() => client.setSegments([{id:'segment',name:'Segment',rules:[{id:'plan',field:'plan',operator:'equals',value:'paid'}]}])); await page.waitForFunction(() => document.querySelector('#react-value').textContent === '"segment"'); await page.evaluate(() => client.flushExposures());
    const beforeInvalid = exposures.length; assert.equal(await page.evaluate(() => {try{client.setFlags([{key:'broken'}]);return false}catch{return true}}),true); await page.evaluate(() => client.flushExposures()); assert.equal(exposures.length,beforeInvalid); assert.equal(await page.textContent('#react-value'),'"segment"');
    await page.evaluate(() => suspend()); await page.waitForSelector('#suspended'); await page.evaluate(() => client.flushExposures()); assert.equal(exposures.length,beforeInvalid,'Suspended uncommitted render must not emit');
    await page.evaluate(() => { globalThis.replacement = makeClient(); show(replacement); }); await page.waitForFunction(() => document.querySelector('#react-value').textContent === '"bootstrap"'); await page.evaluate(() => replacement.flushExposures());
    const beforeOld = exposures.length; await page.evaluate(() => client.reset()); await page.evaluate(() => client.flushExposures()); assert.equal(exposures.length, beforeOld); assert.equal(await page.textContent('#react-value'), '"bootstrap"');
    await page.evaluate(() => remove()); const afterUnmount = exposures.length; await page.evaluate(async () => { replacement.identify('unused'); await replacement.flushExposures(); }); assert.equal(exposures.length, afterUnmount); assert.equal(await page.evaluate(()=>replacement.refreshConfig()),true,'Unmount must not close caller-owned transport');
    await page.evaluate(() => { globalThis.svelteClient = makeClient(); mountSvelte(svelteClient); }); await page.waitForFunction(() => document.querySelector('#svelte-value')?.textContent === '"bootstrap"'); await page.evaluate(() => svelteClient.flushExposures());
    await page.evaluate(() => svelteClient.refreshConfig()); await page.waitForFunction(() => document.querySelector('#svelte-value').textContent === 'false'); await page.evaluate(() => svelteClient.identify('svelte-person', { plan: 'paid' })); await page.waitForFunction(() => document.querySelector('#svelte-value').textContent === 'true'); await page.evaluate(() => svelteClient.flushExposures()); assert.equal(exposures.at(-1).user.id, 'svelte-person');
    await page.evaluate(() => removeSvelte()); const afterSvelte = exposures.length; await page.evaluate(async () => { svelteClient.reset(); await svelteClient.flushExposures(); await Promise.all([client.closeConfig(), replacement.closeConfig(), svelteClient.closeConfig(), client.closeExposures(), replacement.closeExposures(), svelteClient.closeExposures()]); }); assert.equal(exposures.length, afterSvelte);
    const hydration = await browser.newPage(); const hydrationErrors = []; hydration.on('pageerror', error => hydrationErrors.push(error.message)); hydration.on('console', message => { if(message.type()==='error') hydrationErrors.push(message.text()); });
    const beforeHydration = exposures.length; await hydration.goto(endpoint+'/hydrate'); await hydration.waitForFunction(()=>globalThis.ready&&document.querySelector('#react-value')?.textContent==='"bootstrap"'); await hydration.evaluate(()=>client.flushExposures()); assert.equal(exposures.length,beforeHydration+1); await hydration.evaluate(()=>client.refreshConfig()); await hydration.waitForFunction(()=>document.querySelector('#react-value').textContent==='false'); await hydration.evaluate(async()=>{remove();await client.closeExposures();await client.closeConfig()}); assert.deepEqual(hydrationErrors,[]); await hydration.close();
    assert.deepEqual(pageErrors, []); results.push({ reactMajor: major, packedSSR: true, hydration: true, strictDeclarations: true, strictMode: true, abandonedRender: true, localDefinitions: true, signedRefresh: true, identityTransitions: true, failedRefreshAnd304: true, replacementAndUnmount: true, compiledSvelte: true }); await page.close();
  }
  console.log(JSON.stringify({ vanillaWithoutFrameworks: true, browser: await browser.version(), results }));
} finally {
  await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(directory, { recursive: true, force: true });
}
