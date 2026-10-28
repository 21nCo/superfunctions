import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertMcpReleaseReady } from './assert-mcpfn-release-ready.mjs';

const internalNames = new Set(['@mcpfn/core','@superfunctions/oauth-core']);
const manifest = {name:'@mcpfn/auth',version:'0.0.6',dependencies:{'@mcpfn/core':'0.0.6','@superfunctions/oauth-core':'^0.1.1','external-library':'^1.0.0'}};
function options(records) {
  const calls=[];
  return {internalNames,calls,lookup:async(name,range)=>{calls.push(`${name}@${range}`);return records[`${name}@${range}`]??[];}};
}
test('requires internal dependencies to exist and rejects an existing target version', async()=>{
  const missing=options({});
  await assert.rejects(assertMcpReleaseReady(manifest,missing),/Publish required internal dependencies.*@mcpfn\/core@0.0.6/);
  const available=options({'@mcpfn/core@0.0.6':['0.0.6'],'@superfunctions/oauth-core@^0.1.1':['0.1.1','0.1.2']});
  assert.equal((await assertMcpReleaseReady(manifest,available)).checked.length,2);
  assert(!available.calls.some(call=>call.startsWith('external-library')));
  await assert.rejects(assertMcpReleaseReady(manifest,options({'@mcpfn/auth@0.0.6':['0.0.6']})),/already exists/);
});
test('does not confuse registry failure with an unpublished version',async()=>{
  await assert.rejects(assertMcpReleaseReady(manifest,{internalNames,lookup:()=>{throw new Error('registry unavailable');}}),/registry unavailable/);
});
test('checks optional and peer declarations without masking required dependencies',async()=>{
  const candidate={...manifest,dependencies:{'@mcpfn/core':'0.0.6'},optionalDependencies:{'@mcpfn/core':'0.0.5'},peerDependencies:{'@superfunctions/oauth-core':'^0.1.1'}};
  const records={'@mcpfn/core@0.0.5':['0.0.5'],'@superfunctions/oauth-core@^0.1.1':['0.1.1']};
  await assert.rejects(assertMcpReleaseReady(candidate,options(records)),/@mcpfn\/core@0.0.6 \(dependencies\)/);
});
test('rejects workspace/file/git/tag substitutions and credential-bearing registry URLs',async()=>{
  for(const range of ['workspace:*','file:../core','git+https://example.com/core','latest']) {
    await assert.rejects(assertMcpReleaseReady({...manifest,dependencies:{'@mcpfn/core':range}},options({})),/non-version internal/);
  }
  await assert.rejects(assertMcpReleaseReady(manifest,{...options({}),registry:'https://user:secret@example.com'}),/without embedded credentials/);
});
test('does not impose this MCP release policy on other packages',async()=>{
  assert.deepEqual(await assertMcpReleaseReady({name:'other-package'},{lookup:()=>assert.fail('unexpected query')}),{applicable:false});
});


test('unlisted packages in internal namespaces still require registry availability', async()=>{
  await assert.rejects(assertMcpReleaseReady({...manifest,dependencies:{'@mcpfn/unlisted':'0.0.1'}},options({})),/@mcpfn\/unlisted@0.0.1/);
});
