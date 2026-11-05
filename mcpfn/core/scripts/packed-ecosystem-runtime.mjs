// Build all seven MCP packages first. NODE18 and NODE20 must name the exact
// 18.18.0 and 20.0.0 executables. Installs only into an owned temporary consumer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const packages = ['core', 'client', 'auth', 'testing', 'inspector', 'datafn', 'cli'];
const runtimes = [['18.18.0', process.env.NODE18], ['20.0.0', process.env.NODE20]];
for (const [version, executable] of runtimes) {
  assert(executable, `Set NODE${version.split('.')[0]} to the exact minimum runtime executable`);
  assert.equal(execFileSync(executable, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim(), version);
}
const temporary = mkdtempSync(join(tmpdir(), 'mcp-ecosystem-runtime-'));
const environment = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
delete environment.NODE_OPTIONS;
const run = (command, args, cwd = temporary, env = environment) => execFileSync(command, args, {
  cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
});

const serverSource = `
import { McpFnRegistry, createMcpFnServer, structuredResult } from '@mcpfn/core';
export function makeServer() {
  return createMcpFnServer({info:{name:'minimum-runtime',version:'1.0.0'},
    registry:new McpFnRegistry().register({name:'echo',description:'Echo a string',
      inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false},
      handler:async input=>structuredResult(input)})});
}
export default makeServer();
`;

const probeSource = String.raw`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createMcpFnClient, stdioTarget, streamableHttpTarget } from '@mcpfn/client';
import { createOAuthResourceServerHandler, diagnoseMcpAuthorization } from '@mcpfn/auth';
import { McpFnTestClient, runScenarios, createMcpFnScenarioReport, runOfficialConformance } from '@mcpfn/testing';
import { startMockOAuthAuthorizationServer } from '@mcpfn/testing/auth';
import { makeServer } from './server.mjs';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const expected = JSON.parse(await readFile('expected.json', 'utf8'));
const flags = process.versions.node.startsWith('18.') ? ['--experimental-global-webcrypto'] : [];
assert.equal(typeof globalThis.crypto?.randomUUID, 'function', 'HTTP requires global WebCrypto');
let phase = 'imports';
let oauth, http, server, client, testClient;
const results = [];
const secret = 'minimum-runtime-fixture-token';
const scenarios = [
  {name:'valid echo',tool:'echo',arguments:{value:'ok'},expect:{isError:false,structuredContent:{value:'ok'},structuredTextParity:true}},
  {name:'reject invalid input',tool:'echo',arguments:{value:42},expect:{isError:true}},
];
const cli = join(dirname(require.resolve('@mcpfn/cli')), 'bin.js');
async function command(args) {
  return execute(process.execPath, [...flags, cli, ...args], {
    cwd:process.cwd(), env:{...process.env, MCPFN_MINIMUM_TOKEN:secret}, timeout:30_000,
  });
}
async function packageMetadata(entry, name) {
  let current = dirname(entry);
  for (;;) {
    try {
      const metadata = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'));
      if (metadata.name === name) return {metadata, directory:current};
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) throw new Error('Cannot resolve package metadata: '+name);
    current = parent;
  }
}
try {
  const versions = {};
  for (const [name, version] of Object.entries(expected)) {
    assert(Object.keys(await import(name)).length, name+' ESM exports');
    assert(Object.keys(require(name)).length, name+' CommonJS exports');
    const resolved = await packageMetadata(require.resolve(name), name);
    assert.equal(resolved.metadata.version, version);
    versions[name] = {version};
    // This checks external runtime resolution only. Core/auth inline their SDK;
    // DataFn has no direct SDK dependency. Their installed resolution is not
    // evidence about the SDK code inside the built artifacts.
    if (['@mcpfn/client', '@mcpfn/testing', '@mcpfn/inspector', '@mcpfn/cli'].includes(name)) {
      const local = createRequire(join(resolved.directory, 'package.json'));
      const sdk = await packageMetadata(local.resolve('@modelcontextprotocol/sdk/client/index.js'), '@modelcontextprotocol/sdk');
      assert.equal(sdk.metadata.version, '1.32.1', name+' external SDK resolution');
      versions[name].externalSdk = sdk.metadata.version;
    }
  }
  for (const name of ['@mcpfn/testing/auth', '@mcpfn/testing/playwright']) {
    assert(Object.keys(await import(name)).length, name+' ESM exports');
    assert(Object.keys(require(name)).length, name+' CommonJS exports');
  }
  results.push({phase, versions});
  phase = 'testing scenarios';
  testClient = await McpFnTestClient.connect(makeServer());
  const scenariosResult = await runScenarios(testClient, scenarios);
  assert(scenariosResult.every(result=>result.status==='passed'), JSON.stringify(scenariosResult));
  const report = createMcpFnScenarioReport(scenariosResult);
  assert.equal(report.failed, 0);
  await testClient.close(); testClient = undefined;
  results.push({phase, count:scenariosResult.length});

  phase = 'OAuth fixture metadata';
  oauth = await startMockOAuthAuthorizationServer();
  const metadataResponse = await fetch(oauth.oauth.metadataUrl);
  assert.equal(metadataResponse.status, 200, 'mock OAuth metadata response');
  const metadata = await metadataResponse.json();
  assert.equal(metadata.issuer, oauth.oauth.issuer.toString());

  phase = 'protected HTTP and discovery';
  server = makeServer();
  const rawHandler = await server.createWebStandardHandler({enableJsonResponse:true});
  let handler;
  http = createServer(async (request, response) => {
    try {
      const chunks=[];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body=Buffer.concat(chunks);
      const headers=new Headers(Object.entries(request.headers).flatMap(([key,value])=>
        Array.isArray(value)?value.map(item=>[key,item]):value===undefined?[]:[[key,value]]));
      const result=await handler(new Request('http://'+request.headers.host+request.url,
        {method:request.method,headers,...(body.length?{body}: {})}));
      response.writeHead(result.status,Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch(error) {response.statusCode=500;response.end(String(error));}
  });
  await new Promise((done,fail)=>{http.once('error',fail);http.listen(0,'127.0.0.1',done)});
  const resource='http://127.0.0.1:'+http.address().port+'/mcp';
  handler=createOAuthResourceServerHandler(rawHandler, {
    resource,authorizationServers:[oauth.origin],allowInsecureLoopbackAuthorizationServers:true,
    scopesSupported:['tools:call'],requiredScopes:['tools:call'],
    verifier:{async verifyAccessToken(token){
      if(token!==secret) throw Error('Invalid fixture token');
      return {token,clientId:'fixture',scopes:['tools:call'],resource:new URL(resource)};
    }},
  });
  const denied=await fetch(resource,{method:'POST'});
  assert.equal(denied.status,401); await denied.body?.cancel();
  const diagnosis=await diagnoseMcpAuthorization(resource);
  assert.equal(diagnosis.ok,true,JSON.stringify(diagnosis));
  client=createMcpFnClient({target:streamableHttpTarget(resource,{requestInit:{headers:{authorization:'Bearer '+secret}}})});
  await client.connect();
  assert.equal((await client.tools.listAll())[0].name,'echo');
  assert.deepEqual((await client.tools.call('echo',{value:'http'})).structuredContent,{value:'http'});
  assert.equal((await client.tools.call('echo',{value:42})).isError,true);
  await client.close(); client=undefined;
  results.push({phase});

  phase='installed CLI';
  assert((await command(['--version'])).stdout.includes(expected['@mcpfn/cli']));
  await command(['manifest','server.mjs','--output','manifest.json']);
  await command(['validate','manifest.json']);
  const cliResult=await command(['test-target',resource,'scenarios.json','--bearer-token-env','MCPFN_MINIMUM_TOKEN','--output','report.json']);
  const serialized=await readFile('report.json','utf8');
  assert.equal(JSON.parse(serialized).failed,0);
  assert(!serialized.includes(secret) && !cliResult.stdout.includes(secret) && !cliResult.stderr.includes(secret));
  results.push({phase});

  phase='stdio production client';
  client=createMcpFnClient({target:stdioTarget({command:process.execPath,args:[...flags,'stdio.mjs']})});
  await client.connect();
  assert.deepEqual((await client.tools.call('echo',{value:'stdio'})).structuredContent,{value:'stdio'});
  await client.close();client=undefined;
  results.push({phase});
  phase='official conformance runtime guard';
  await assert.rejects(runOfficialConformance({url:resource}), /Node.js 22 or newer/);
  results.push({phase});
  console.log(JSON.stringify({ok:true,node:process.versions.node,results}));
} catch(error) {
  console.error(JSON.stringify({ok:false,node:process.versions.node,phase,error:String(error),results}));
  process.exitCode=1;
} finally {
  try {await client?.close();} finally {
    try {await testClient?.close();} finally {
      try {await server?.close();} finally {
        try {if(http?.listening){http.closeAllConnections();await new Promise(done=>http.close(done));}}
        finally {await oauth?.close();}
      }
    }
  }
}
`;

try {
  const dependencies = {'@playwright/test':'1.59.1'};
  const expected = {};
  for (const name of packages) {
    const directory = resolve(repo, 'mcpfn', name);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    const [packed] = JSON.parse(run('npm', ['pack','--json','--pack-destination',temporary], directory));
    dependencies[manifest.name] = `file:./${packed.filename}`;
    expected[manifest.name] = manifest.version;
  }
  writeFileSync(join(temporary,'package.json'),JSON.stringify({private:true,type:'module',dependencies}));
  console.log(run('npm',['install','--ignore-scripts','--no-audit','--no-fund']));
  writeFileSync(join(temporary,'expected.json'),JSON.stringify(expected));
  writeFileSync(join(temporary,'server.mjs'),serverSource);
  writeFileSync(join(temporary,'stdio.mjs'),"import server from './server.mjs'; await server.serveStdio();\n");
  writeFileSync(join(temporary,'scenarios.json'),JSON.stringify([
    {name:'valid echo',tool:'echo',arguments:{value:'ok'},expect:{isError:false,structuredContent:{value:'ok'},structuredTextParity:true}},
    {name:'reject invalid input',tool:'echo',arguments:{value:42},expect:{isError:true}},
  ]));
  writeFileSync(join(temporary,'probe.mjs'),probeSource);
  let failed = false;
  for (const [version, executable] of runtimes) {
    try {
      console.log(run(executable,[...(version.startsWith('18.')?['--experimental-global-webcrypto']:[]),'probe.mjs']));
    } catch(error) {
      failed = true;
      process.stderr.write(error.stdout ?? '');
      process.stderr.write(error.stderr ?? '');
      console.error(`Installed ecosystem probe failed on Node ${version}`);
    }
  }
  if (failed) process.exitCode = 1;
} finally {
  rmSync(temporary,{recursive:true,force:true});
}
