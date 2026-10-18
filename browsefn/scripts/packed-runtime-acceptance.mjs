#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after building the selected shared packages and both BrowseFn packages.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = mkdtempSync(join(tmpdir(), 'browsefn-packed-'));
const packs = join(temporary, 'packs'); mkdirSync(packs);
const npmCommand = process.env.NPM_CLI ? process.execPath : 'npm';
const npmArgs = args => process.env.NPM_CLI ? [process.env.NPM_CLI, ...args] : args;
const run = (command, args, cwd) => execFileSync(command === 'npm' ? npmCommand : command, command === 'npm' ? npmArgs(args) : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const node = (file, cwd) => process.env.BROWSEFN_NODE
  ? run(process.env.BROWSEFN_NODE, [file], cwd)
  : run('npm', ['exec', '--yes', '--package=node@20.19.0', '--', 'node', file], cwd);
const pack = path => {
  const result = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packs], join(root, path)));
  return join(packs, result[0].filename);
};
try {
  const corePackages = ['packages/observability', 'packages/http', 'packages/middleware', 'packages/db', 'packages/storage', 'packages/storage-local', 'browsefn/typescript'].map(pack);
  const adminPackages = ['mcpfn/core', 'packages/admin', 'browsefn/admin'].map(pack);
  for (const kind of ['core', 'admin']) {
    const cwd = join(temporary, kind); mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...corePackages, ...(kind === 'admin' ? adminPackages : [])], cwd);
    const audit = spawnSync(npmCommand, npmArgs(['audit', '--omit=dev', '--json']), { cwd, encoding: 'utf8' });
    const report = JSON.parse(audit.stdout);
    assert.ok(report.metadata?.vulnerabilities, audit.stdout || audit.stderr);
    console.log(JSON.stringify({ kind, productionVulnerabilities: report.metadata.vulnerabilities }));
    assert.equal(report.metadata.vulnerabilities.total, 0, `${kind} runtime dependency audit must be clean`);
    writeFileSync(join(cwd, 'smoke.cjs'), `
const assert=require('node:assert/strict');
const {browseFn,createBrowseFnRouter,RateLimiter}=require('browsefn');
const {createRouter}=require('@superfunctions/http/router');
assert.equal(typeof createBrowseFnRouter(browseFn()),'object');assert.equal(typeof createRouter({routes:[]}),'object');
(async()=>{const limiter=new RateLimiter({requests:1,window:10000});assert.equal(await limiter.checkLimit('one'),true);assert.equal(await limiter.checkLimit('two'),false);console.log('CJS synchronous routers and lazy aggregate limiter passed',process.version);})().catch(e=>{console.error(e);process.exitCode=1});
`);
    writeFileSync(join(cwd, 'smoke.mjs'), `
import assert from 'node:assert/strict';import {createServer} from 'node:http';import {browseFn,createBrowseFnRouter} from 'browsefn';
const server=createServer((_req,res)=>res.end('<title>packed</title><p>hello</p><a href="/docs">Docs</a>'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {const browser=browseFn();const page=await browser.web.getPage('http://127.0.0.1:'+server.address().port,{format:'markdown',includeLinks:true});assert.equal(page.metadata.title,'packed');assert.equal(page.links.length,1);assert.match(page.content,/\\[Docs\\]/);assert.equal(typeof createBrowseFnRouter(browser),'object');
${kind === 'admin' ? `const {createBrowseFnDomainAdminService,createBrowseFnAdminAdapter}=await import('@browsefn/admin');const scope={installationId:'install',workspaceId:'workspace',projectId:'project',environmentId:'environment',namespace:'tenant'};const service=createBrowseFnDomainAdminService({browsefn:browser,scope});const context={scope,actor:{id:'operator',type:'user',permissions:['*']},requestId:'request',source:'console'};const listed=await service.listProviders({},context);assert.ok(listed.items.some(item=>item.name==='cheerio'));assert.equal(typeof createBrowseFnAdminAdapter(service),'object');await assert.rejects(service.listProviders({},{...context,scope:{...scope,namespace:'other'}}));` : ''}
console.log('${kind} ESM HTTP/router${kind === 'admin' ? '/scoped admin' : ''} passed',process.version);
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve()));}
`);
    writeFileSync(join(cwd, 'types.mts'), `import {browseFn,createBrowseFnRouter} from 'browsefn';import {createRouter} from '@superfunctions/http/router';createBrowseFnRouter(browseFn());createRouter({routes:[]});${kind === 'admin' ? "import {createBrowseFnAdminAdapter} from '@browsefn/admin';void createBrowseFnAdminAdapter;" : ''}`);
    writeFileSync(join(cwd, 'types.cts'), `import {browseFn,createBrowseFnRouter} from 'browsefn';createBrowseFnRouter(browseFn());`);
    console.log(node('smoke.cjs', cwd).trim()); console.log(node('smoke.mjs', cwd).trim());
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--skipLibCheck', 'types.mts', 'types.cts'], cwd);
  }
  console.log(JSON.stringify({ ok: true, nodeMinimum: '20.19.0', isolatedCoreAndAdmin: true }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
