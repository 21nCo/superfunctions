/** Opt-in actual Docker acceptance. Cached POSIX /bin/sh image required; never pulls. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedDockerExecutor } from '../dist/index.mjs';
const context=process.env.CIFN_DOCKER_CONTEXT, image=process.env.CIFN_DOCKER_IMAGE;
assert.ok(context && image, 'Set explicit CIFN_DOCKER_CONTEXT and cached CIFN_DOCKER_IMAGE');
const directory=await mkdtemp(join(tmpdir(),'cifn-owned-docker-native-'));
const workspace=join(directory,'workspace'),stateDirectory=join(directory,'state');
await mkdir(workspace);
try {
 const executor=new OwnedDockerExecutor({context,stateDirectory,timeoutMs:10000});
 const success=await executor.execute({image,workspace,owner:'native-success',env:{OWNED_VALUE:'fixture-only-value'},command:'printf "%s" "$OWNED_VALUE" > /workspace/value'});
 assert.equal(success.exitCode,0);assert.equal(await readFile(join(workspace,'value'),'utf8'),'fixture-only-value');assert.deepEqual(await readdir(stateDirectory),[]);
 const failure=await executor.execute({image,workspace,owner:'native-nonzero',command:'exit 7'});assert.equal(failure.exitCode,7);assert.deepEqual(await readdir(stateDirectory),[]);
 const controller=new AbortController();let observed=false;
 const cancelled=await executor.execute({image,workspace,owner:'native-cancel',signal:controller.signal,command:'printf "owned-started\\n"; sleep 30',onLines:lines=>{if(lines.includes('owned-started')){observed=true;controller.abort();}}});
 assert.equal(observed,true);assert.equal(cancelled.exitCode,1);assert.deepEqual(await readdir(stateDirectory),[]);
 console.log(JSON.stringify({passed:true,nativeDocker:true,cases:3,context,image,ownedContainersRemoved:true}));
} finally {
 const receipts=await readdir(stateDirectory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
 if(receipts.length===0)await rm(directory,{recursive:true,force:true});
 else console.error('Uncertain container ownership retained for explicit operator reconciliation:',directory);
}
