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
const require = createRequire(import.meta.url);
for (const compiler of [createSchemaCompiler, require('@mcpfn/core').createSchemaCompiler]) {
  for (const [ref, key] of [['#%2F$defs%2Fnode','node'], ['#/$defs/%252F','%2F'], ['#/$defs/a~1b','a/b'], ['#/$defs/%E2%9C%93','✓']]) {
    const check = compiler('ajv').compile({ type:'object', $defs:{[key]:{type:'string'}}, properties:{ value:{$ref:ref} } });
    assert.equal(check({value:'ok'}), true); assert.equal(check({value:42}), false);
  }
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
