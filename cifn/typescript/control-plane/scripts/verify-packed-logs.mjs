/** Fresh production tarballs exercising native HTTP/SQLite killed-runner log recovery. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'cifn-packed-logs-'));
const run=(command,args,cwd=directory)=>execFileSync(command==='npm'&&process.env.CIFN_NPM_CLI?process.execPath:command,command==='npm'&&process.env.CIFN_NPM_CLI?[process.env.CIFN_NPM_CLI,...args]:args,{cwd,encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});
try {
  const manifests=new Map();
  for(const path of run('git',['ls-files','**/package.json'],root).trim().split('\n')) {
    const manifest=JSON.parse(await readFile(join(root,path),'utf8'));
    if(manifest.name)manifests.set(manifest.name,{...manifest,directory:join(root,path.slice(0,-'package.json'.length))});
  }
  const packages=new Map();
  function visit(name){if(packages.has(name))return;const manifest=manifests.get(name);assert.ok(manifest,`Local package ${name}`);packages.set(name,manifest);for(const dep of Object.keys({...manifest.dependencies,...manifest.optionalDependencies}))if(manifests.has(dep))visit(dep);}
  visit('@cifn/runner');
  const dependencies={};
  for(const [name,manifest] of packages){const result=JSON.parse(run('npm',['pack','--json','--pack-destination',directory],manifest.directory));dependencies[name]='file:'+join(directory,result[0].filename);}
  await writeFile(join(directory,'package.json'),JSON.stringify({name:'cifn-owned-packed-logs',version:'1.0.0',private:true,type:'module',dependencies},null,2));
  run('npm',['install','--omit=dev','--no-fund']);
  const moduleRoot = await realpath(join(directory, 'node_modules'));
  for (const name of ['@cifn/runner', '@cifn/control-plane', '@logfn/core']) {
    const installed = await realpath(join(directory, 'node_modules', name));
    assert.ok(installed.startsWith(moduleRoot + '/'), 'Consumer must use its installed package');
  }
  await writeFile(join(directory, 'consumer.cjs'), "const assert=require('node:assert/strict');assert.equal(typeof require('@cifn/runner').RemoteRunner,'function');assert.equal(typeof require('@cifn/runner').OwnedDockerExecutor,'function');assert.equal(typeof require('@cifn/control-plane').createApp,'function');assert.equal(require('@cifn/runner').executeOwnedCheckout,require('@cifn/control-plane').executeOwnedCheckout);");
  await writeFile(join(directory, 'consumer.mjs'), "import assert from 'node:assert/strict';import * as runner from './node_modules/@cifn/runner/dist/index.mjs';import * as control from './node_modules/@cifn/control-plane/dist/index.mjs';assert.equal(typeof runner.RemoteRunner,'function');assert.equal(typeof runner.OwnedDockerExecutor,'function');assert.equal(typeof control.createApp,'function');const {createLogger}=await import('@logfn/core');const events=[];const logger=createLogger({name:'installed',sinks:[batch=>events.push(...batch)]});logger.info('installed logfn');await logger.flush();assert.equal(events[0].msg,'installed logfn');");
  run(process.execPath, ['consumer.cjs']);
  run(process.execPath, ['consumer.mjs']);
  await writeFile(join(directory, 'owned-docker.mjs'), `
import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';import{createServer}from'node:http';import{once}from'node:events';
import {join} from 'node:path';
import {OwnedDockerExecutor, executeRemoteShellJob} from './node_modules/@cifn/runner/dist/index.mjs';
const stateDirectory=join(process.cwd(),'owned-docker-state'),socket=join(process.cwd(),'engine.sock');let id='',present=false,running=false,exec=0,created=0;const cid='a'.repeat(64);
const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=text?JSON.parse(text):undefined;const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 if(req.url==='/info')return json({ID:'fake-daemon'});
 if(req.url.startsWith('/containers/create')){created++;present=true;id=body.Labels['io.21n.cifn.owner'];return json({Id:cid},201);}
 if(req.url.endsWith('/exec')){exec++;assert.ok(body.Env.some(value=>value.startsWith('CIFN_INTERNAL_COMMAND=')));return json({Id:exec.toString(16).padStart(64,'0')},201);}
 if(req.url.startsWith('/exec/')&&req.url.endsWith('/start')){const path=join(stateDirectory,id,'receipt.json');assert.equal((await stat(path)).mode&511,384);const receipt=JSON.parse(await readFile(path,'utf8'));assert.equal(receipt.owner,'packed-execution');assert.equal(receipt.execId,exec.toString(16).padStart(64,'0'));const output=Buffer.from('owned output'),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(output.length,4);res.end(Buffer.concat([header,output]));return;}
 if(req.url.startsWith('/exec/'))return json({ID:exec.toString(16).padStart(64,'0'),ContainerID:cid,Running:false,ExitCode:0});
 if(req.method==='DELETE'){present=false;running=false;res.writeHead(204);res.end();return;}
 if(req.url.endsWith('/start')){running=true;res.writeHead(204);res.end();return;}
 if(req.url.startsWith('/containers/'))return present?json({Id:cid,Config:{Labels:{'io.21n.cifn.owner':id}},State:{Running:running}}):json({message:'absent'},404);
 json({},500);
});server.listen(socket);await once(server,'listening');
try{
 const executor=new OwnedDockerExecutor({stateDirectory,context:'fixture-only'},async args=>({exitCode:0,stdout:args[0]==='context'?JSON.stringify('unix://'+socket):'fake-daemon',stderr:'',lines:[]}));
 const result=await executeRemoteShellJob({runId:'packed',jobKey:'build',jobSpec:{'runs-on':'default',image:'fixture-only',steps:[{run:'printf private-owned-command'},{run:'true'}]}},undefined,undefined,undefined,undefined,undefined,{ownedDockerExecutor:executor,executionOwner:'packed-execution'});
 assert.equal(result.status,'success');assert.equal(created,1);assert.equal(exec,2);assert.deepEqual(await readdir(stateDirectory),[]);
 console.log(JSON.stringify({installedOwnedDockerProtocol:true,actualUnixTransport:true,perJobProtocol:true,nativeDocker:false}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
`);
  process.stdout.write(run(process.execPath, ['owned-docker.mjs']));
  console.log(run(process.execPath, ['node_modules/@cifn/runner/scripts/verify-workspace-archives.mjs']));
  if(process.env.CIFN_TEST_NATIVE_DOCKER==='1')process.stdout.write(run(process.execPath,['node_modules/@cifn/runner/scripts/verify-per-job-docker.mjs']));

  const receipt = run(process.execPath, ['node_modules/@cifn/control-plane/scripts/verify-remote-logs.mjs']);
  process.stdout.write(receipt);
  process.stdout.write(run(process.execPath, ['node_modules/@cifn/control-plane/scripts/verify-step-status.mjs']));
  process.stdout.write(run(process.execPath, ['node_modules/@cifn/control-plane/scripts/verify-lifecycle.mjs']));
  let auditOutput;
  try { auditOutput = run('npm', ['audit', '--omit=dev', '--json']); }
  catch (error) { if (!error.stdout) throw error; auditOutput = error.stdout; }
  const audit = JSON.parse(auditOutput);
  assert.equal(audit.metadata.vulnerabilities.total, 0);
  // Consumer tooling is installed only after recording the normal production closure.
  run('npm', ['install', '--save-dev', 'typescript@5.9.3', '@types/node@20.19.25', '--no-fund']);
  await writeFile(join(directory, 'consumer.ts'), `import {Runner, OwnedDockerExecutor, type OwnedDockerOptions, type DockerReceiptDecision, type DockerCleanupReceipt, type ArchiveLimits, executeOwnedCheckout, type CheckoutOptions, type RunnerOptions} from '@cifn/runner';
import {LogFnStepOutputDispatcher, type StepOutputCheckpoint, resolvePipelineDoc, type ResolveOptions, type ForkApproval, type ExecutionDecision, type ExecutionInspection, LogFnLifecycleDispatcher, type LifecycleEvent, type LifecycleOwner, type ApiErrorTelemetry, DatabaseStore, stepEventDigest, validateStepEvent, type ClaimIdentity, type StepEvent} from '@cifn/control-plane';
const observer: NonNullable<RunnerOptions['onStepStatus']> = async (stepKey, status) => {
  const value = {sequence:0,stepKey,status}; const event: StepEvent = {...value,digest:stepEventDigest(value)};
  if (!validateStepEvent(event)) throw new Error('invalid');
};
export async function report(store: DatabaseStore, identity: ClaimIdentity, event: StepEvent): Promise<number> {
  return (await store.appendStepEvent(identity,event)).nextSequence;
}
export function lifecycle(store: DatabaseStore) { return new LogFnLifecycleDispatcher(store, async events => { const id: unknown = events[0]?.ctx?.eventId; void id; }); }
export async function telemetry(store: DatabaseStore, owner: LifecycleOwner, event: ApiErrorTelemetry) {
  await store.recordApiError(event);
  return {records: await store.getTelemetryRecords(owner), owners: await store.listLifecycleOwners(), pruned: await store.pruneTelemetry(owner, Date.now())};
}
export async function output(store: DatabaseStore, runId: string, dispatchId: string) {
  const status: StepOutputCheckpoint | undefined = await store.getStepOutputStatus(runId, dispatchId);
  return {status, dispatcher: new LogFnStepOutputDispatcher(store, async events => { void events; })};
}
export async function adjudication(store: DatabaseStore, runId: string, dispatchId: string, decision: ExecutionDecision) {
  const snapshot: ExecutionInspection | undefined = await store.inspectExecution(runId, dispatchId);
  return {snapshot, receipt: await store.adjudicateExecution(runId, dispatchId, decision)};
}
export const approval: ForkApproval = { id: "owned", baseRepositoryId: 1, baseRepository: "base/repo", baseRepositoryUrl: "https://github.com/base/repo.git", baseSha: "a".repeat(40), headRepositoryId: 2, headRepository: "fork/repo", headRepositoryUrl: "https://github.com/fork/repo.git", headSha: "b".repeat(40), allowedSecrets: [] };
export function resolve(options: ResolveOptions) { return resolvePipelineDoc({repo:'owner/repo',ref:'HEAD'}, options); }
export async function checkout(options: CheckoutOptions) { return executeOwnedCheckout(options); }
export const archivePolicy: ArchiveLimits = {maxBytes: 64 * 1024 * 1024};
export function ownedDocker(options: OwnedDockerOptions) { return new OwnedDockerExecutor(options); }
export async function cleanupDocker(executor: OwnedDockerExecutor, decision: DockerReceiptDecision): Promise<DockerCleanupReceipt> { executor.inspectReceipt(decision.id); return executor.cleanupReceipt(decision); }
export const typed = {Runner, observer};
`);
  run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--skipLibCheck', 'false', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts']);
  console.log(JSON.stringify({passed:true, strictDeclarations:true, installedPackages:packages.size, cjs:true, esm:true, productionAudit:0, node:process.version}));
} finally { await rm(directory, {recursive:true, force:true}); }
