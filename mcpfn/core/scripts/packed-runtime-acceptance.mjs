// Run after building core and shared admin. Optional NODE18/NODE20 executable paths.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'mcp-packed-runtime-'));
function run(command, args, cwd = temporary) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}
try {
  const pack = path => JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], resolve(root, path)))[0].filename;
  const core = pack('core');
  const admin = pack('../packages/admin');
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    '@mcpfn/core': `file:./${core}`, '@superfunctions/admin': `file:./${admin}`,
  } }));
  console.log(run('npm', ['install', '--ignore-scripts', '--no-fund', '--no-audit']));
  const audit = JSON.parse(run('npm', ['audit', '--omit=dev', '--json']));
  console.log('Production audit:', JSON.stringify(audit.metadata.vulnerabilities));
  writeFileSync(join(temporary, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSchemaCompiler, McpFnRegistry, createMcpFnServer, structuredResult } from '@mcpfn/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
const require = createRequire(import.meta.url);
for (const compiler of [createSchemaCompiler, require('@mcpfn/core').createSchemaCompiler]) {
 for (const engine of ['ajv', 'cfworker']) {
  for (const [ref, key] of [['#%2F$defs%2Fnode','node'], ['#/$defs/%252F','%2F'], ['#/$defs/a~1b','a/b'], ['#/$defs/%E2%9C%93','✓']]) {
    const check = compiler(engine).compile({ type:'object', $defs:{[key]:{type:'string'}}, properties:{ value:{$ref:ref} } });
    assert.equal(check({value:'ok'}), true); assert.equal(check({value:42}), false);
  }
 }
}
// Consumer SDK classes must retain protocol semantics across both bundled entry points.
for (const runtime of [await import('@mcpfn/core'), require('@mcpfn/core')]) {
 const registry = new runtime.McpFnRegistry().register({name:'denied',description:'Denied',inputSchema:{type:'object'},handler:async()=>runtime.structuredResult({ok:true})});
 const server = runtime.createMcpFnServer({info:{name:'foreign-error',version:'1'},registry,clientProfiles:{profiles:[],resolveVerifiedIdentity:()=>{throw new McpError(ErrorCode.InvalidRequest,'policy denied',{reason:'policy'});}}});
 const client = new Client({name:'consumer-error',version:'1'});
 try {
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  await assert.rejects(client.callTool({name:'denied',arguments:{}}),error=>error.code===ErrorCode.InvalidRequest && error.data?.reason==='policy');
 } finally {await client.close();await server.close();}
}
// Preserve the next-origin schema/profile fixes in the installed artifact.
// Exercise both export formats through the official protocol, including rejection.
for (const [format, api] of [['ESM', await import('@mcpfn/core')], ['CJS', require('@mcpfn/core')]]) {
 const handler=async input=>api.structuredResult(input);
 const dependency={type:'object',$id:'https://packed.invalid/shared',properties:{value:{type:'string'}},required:['value']};
 const consumer={name:'a_consumer',description:'Uses shared schema',inputSchema:{type:'object',properties:{nested:{$ref:'https://packed.invalid/shared'}},required:['nested']},handler};
 async function assertProtocol(candidate, names) {
  const protocolClient=new Client({name:'next-packed-regression',version:'1'});
  try {
   const [left,right]=InMemoryTransport.createLinkedPair();await candidate.connect(right);await protocolClient.connect(left);
   assert.deepEqual((await protocolClient.listTools()).tools.map(tool=>tool.name),names);
   assert.deepEqual((await protocolClient.callTool({name:'a_consumer',arguments:{nested:{value:'ok'}}})).structuredContent,{nested:{value:'ok'}});
   assert.equal((await protocolClient.callTool({name:'a_consumer',arguments:{nested:{value:42}}})).isError,true);
  } finally {await protocolClient.close();await candidate.close();}
 }
 const original=new api.McpFnRegistry()
  .register({name:'z_provider',description:'Shared schema',inputSchema:dependency,handler}).register(consumer);
 const extended=api.defineMcpFnServer({info:{name:'ordered-clone',version:'1'},registry:original,
  tools:[{name:'extra',description:'Added',inputSchema:{type:'object'},handler}]});
 assert.equal(original.has('extra'),false);
 await assertProtocol(extended.createServer(),['a_consumer','extra','z_provider']);
 for (const source of ['hidden-tool','prompt']) {
  const profileRegistry=new api.McpFnRegistry();
  if(source==='hidden-tool') profileRegistry.register({name:'z_provider',description:'Hidden schema',inputSchema:dependency,handler});
  else profileRegistry.registerPrompt({name:'schema_prompt',argumentsSchema:dependency,get:async()=>({messages:[]})});
  profileRegistry.register(consumer);
  const profiled=api.createMcpFnServer({info:{name:'profile-'+source,version:'1'},registry:profileRegistry,
   toolVisibility:({tool})=>tool.name==='a_consumer',
   clientProfiles:{profiles:[{id:'packed',version:'1',matches:()=>true}],resolveVerifiedIdentity:()=>({subject:'verified'})}});
  await assertProtocol(profiled,['a_consumer']);
 }
 console.log('Packed next declaration-order, hidden-tool and prompt-schema profile regressions passed:',format);
}
const registry = new McpFnRegistry().register({name:'echo',description:'Echo',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},handler:async value=>structuredResult(value)});
const server = createMcpFnServer({info:{name:'packed',version:'1'},registry});
const client = new Client({name:'consumer',version:'1'});
try {
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 assert.equal((await client.listTools()).tools[0].name,'echo');
 assert.deepEqual((await client.callTool({name:'echo',arguments:{value:'ok'}})).structuredContent,{value:'ok'});
 assert.equal((await client.callTool({name:'echo',arguments:{value:42}})).isError,true);
} finally {await client.close();await server.close();}
if (globalThis.crypto?.randomUUID) {
 const httpServer=createMcpFnServer({info:{name:'packed-http',version:'1'},registry});
 try {
  const handler=await httpServer.createWebStandardHandler({enableJsonResponse:true});
  const response=await handler(new Request('https://example.test/mcp',{method:'POST',headers:{accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'consumer',version:'1'}}})}));
  assert.equal(response.status,200);assert.equal((await response.json()).result.serverInfo.name,'packed-http');
 } finally {await httpServer.close();}
 console.log('Packed HTTP initialization passed');
} else { console.log('HTTP prerequisite absent: enable global WebCrypto for Node18 HTTP'); }
if (Number(process.versions.node.split('.')[0])>=20) {
 const admin=await import('@superfunctions/admin');
 const scope={organizationId:'org'};const cursor=admin.encodeAdminCursor(scope,{offset:2});
 assert.deepEqual(admin.decodeAdminCursor(cursor,scope),{offset:2});
 assert.throws(()=>admin.decodeAdminCursor(cursor,{organizationId:'other'}));
 assert.equal(admin.normalizeAdminPageLimit(10),10);
}
console.log('Packed ESM/CJS schema validation, MCP transport, and supported admin smoke passed:',process.version);
`);
  for (const executable of new Set([process.env.NODE18, process.env.NODE20 ?? process.execPath].filter(Boolean))) {
    console.log(run(executable, ['smoke.mjs']));
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
