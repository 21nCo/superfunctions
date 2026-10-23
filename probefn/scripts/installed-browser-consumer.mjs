/** Copied into the fresh tarball consumer by verify-distribution.mjs --browser. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { ArtifactStore } from '@probefn/storage';
import { DatabaseSync } from 'node:sqlite';

const project = join(process.cwd(), 'browser-project');
await mkdir(project);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const url = `http://127.0.0.1:${port}`;
const html = `<!doctype html><html><body><h1>Installed browser fixture</h1><input id="transient"><button id="submit-transient" onclick="document.querySelector('#transient-result').textContent=document.querySelector('#transient').value+':'+(++window.transientCount)">Submit</button><p id="transient-result">Waiting</p><script>window.transientCount=0</script><button id="change" onclick="localStorage.setItem('result','Action completed');document.querySelector('#result').textContent=localStorage.getItem('result')">Change</button><p id="result">Waiting</p><script>document.querySelector('#result').textContent=localStorage.getItem('result')||'Waiting'</script></body></html>`;
await writeFile(join(project, 'app.mjs'), `import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs'; writeFileSync('app.pid',String(process.pid)); createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(${JSON.stringify(html)});}).listen(${port},'127.0.0.1',()=>console.log('Ready ${url}'));`);
await writeFile(join(project, 'probefn.config.mjs'), `export default ${JSON.stringify({projectName:'installed-browser',storageCaps:{maxArtifactBytes:2097152,maxEventsPerSink:3},devServers:{web:{mode:'spawn',name:'web',command:`'${process.execPath}' app.mjs`,cwd:'.',url,readyPattern:'Ready (https?://[^\\s]+)',timeoutMs:10000}},deterministicDefaults:{networkIdleMs:100}})};`);
const executable = chromium.executablePath();
console.log(JSON.stringify({engine:'chromium',executable,version:execFileSync(executable,['--version'],{encoding:'utf8',timeout:10000}).trim()}));
const bin = join(process.cwd(), 'node_modules/.bin/probefn');
const transport = new StdioClientTransport({command:bin,args:['mcp','serve','--stdio'],cwd:project,stderr:'pipe'});
let diagnostics=''; transport.stderr?.on('data',chunk=>{diagnostics+=chunk;});
const client = new Client({name:'installed-browser-acceptance',version:'1.0.0'});
let started = false;
let cliSessionId;
let cliRunId;
async function call(name,args){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.structuredContent?.ok,true,JSON.stringify(result));return result.structuredContent.data;}
const sessionId='installed_browser';
try {
  await client.connect(transport);
  console.log(JSON.stringify({started:await call('probefn_session_start',{configPath:'probefn.config.mjs',sessionId,runId:'installed_browser_run'})}));started=true;
  await call('probefn_page_open',{sessionId,url});
  await call('probefn_page_act',{sessionId,action:'click',selector:'#change'});
  await call('probefn_page_act',{sessionId,action:'fill',selector:'#transient',value:'MCP Ada'});
  await call('probefn_page_act',{sessionId,action:'click',selector:'#submit-transient'});
  const checkpoint=await call('probefn_checkpoint_create',{sessionId,name:'after-action',includeStyles:true,includeTrace:true});
  const residentDom=JSON.parse(await readFile(join(project,'.artifacts/runs/installed_browser_run/checkpoints/after-action/dom.json'),'utf8'));
  assert(residentDom.html.includes('<p id="transient-result">MCP Ada:1</p>'));
  let fenced;
  try { execFileSync(bin,['report','export','--session',sessionId,'--format','json','--json'],{cwd:project,encoding:'utf8',timeout:10000}); assert.fail('Live MCP owner must fence CLI mutation'); }
  catch(error){assert.equal(error.status,1);const start=String(error.stderr).indexOf('{\n  "ok"');assert(start>=0);fenced=JSON.parse(String(error.stderr).slice(start));}
  assert.equal(fenced.error.code,'E_SESSION_ALREADY_RUNNING');
  console.log(JSON.stringify({checkpoint}));
  await writeFile(join(project,'live-flow.json'),JSON.stringify({version:1,steps:[
    {command:'page.open',url},
    {command:'page.act',action:'fill',selector:'#transient',value:'Installed Ada'},
    {command:'page.act',action:'click',selector:'#submit-transient'},
    {command:'checkpoint.create',name:'transient-flow',includeTrace:true},
    {command:'report.export',format:'json'},
  ]}));
  await call('probefn_run_flow',{sessionId,file:'live-flow.json'});
  const flowDom=JSON.parse(await readFile(join(project,'.artifacts/runs/installed_browser_run/checkpoints/transient-flow/dom.json'),'utf8'));
  assert(flowDom.html.includes('<p id="transient-result">Installed Ada:1</p>'));
  const flowReport=JSON.parse(await readFile(join(project,'.artifacts/runs/installed_browser_run/report.json'),'utf8'));
  assert.equal(typeof flowReport.tracePath,'string');
  const traceBytes=await readFile(join(project,flowReport.tracePath));
  const flowManifest=JSON.parse(await readFile(join(project,'.artifacts/runs/installed_browser_run/checkpoints/transient-flow/checkpoint.json'),'utf8'));
  assert.deepEqual(flowManifest.artifacts.find(artifact=>artifact.kind==='trace'),{kind:'trace',path:flowReport.tracePath,sha256:createHash('sha256').update(traceBytes).digest('hex')});
  const traceEvents=execFileSync('unzip',['-p',join(project,flowReport.tracePath),'trace.trace'],{encoding:'utf8'});
  assert(traceEvents.includes('Installed Ada'));assert(traceEvents.includes('#submit-transient'));
  await writeFile(join(project,'cli.config.mjs'),`export default ${JSON.stringify({projectName:'installed-cli',storageCaps:{maxArtifactBytes:2097152,maxEventsPerSink:3},devServers:{web:{mode:'attach',name:'web',url}},deterministicDefaults:{networkIdleMs:100}})}`);
  const cliStarted=JSON.parse(execFileSync(bin,['session','start','--config','cli.config.mjs','--json'],{cwd:project,encoding:'utf8',timeout:10000}));
  assert.equal(cliStarted.ok,true);cliSessionId=cliStarted.data.sessionId;cliRunId=cliStarted.data.runId;
  const cliFlowDocument=JSON.parse(await readFile(join(project,'live-flow.json'),'utf8'));
  cliFlowDocument.steps.find(step=>step.command==='checkpoint.create').name='transient-cli-flow';
  await writeFile(join(project,'live-cli-flow.json'),JSON.stringify(cliFlowDocument));
  const cliFlow=JSON.parse(execFileSync(bin,['run','flow','--session',cliSessionId,'--file','live-cli-flow.json','--json'],{cwd:project,encoding:'utf8',timeout:15000}));
  assert.equal(cliFlow.ok,true);
  const cliFlowDom=JSON.parse(await readFile(join(project,`.artifacts/runs/${cliRunId}/checkpoints/transient-cli-flow/dom.json`),'utf8'));
  assert(cliFlowDom.html.includes('<p id="transient-result">Installed Ada:1</p>'));
  const cliFlowReport=JSON.parse(await readFile(join(project,`.artifacts/runs/${cliRunId}/report.json`),'utf8'));
  assert.notEqual(cliFlowReport.tracePath,flowReport.tracePath);
  assert.deepEqual(await readFile(join(project,flowReport.tracePath)),traceBytes);
  console.log(JSON.stringify({installedLiveFlow:true,installedCliFlow:true,installedResidentCalls:true,liveOwnerFencesCli:true,tracePath:flowReport.tracePath,traceBytes:traceBytes.length,traceContainsActions:true}));
  const denied=await client.callTool({name:'probefn_checkpoint_create',arguments:{sessionId,name:'oversized',artifactCapBytes:1}});
  assert.equal(denied.isError,true);assert.equal(denied.structuredContent.error.code,'E_STORAGE_CAP_EXCEEDED');
  await assert.rejects(readFile(join(project,'.artifacts/runs/installed_browser_run/checkpoints/oversized/checkpoint.json')),{code:'ENOENT'});
  let cliDenied;
  try {execFileSync(bin,['checkpoint','create','--session',cliSessionId,'--name','oversized-cli','--artifact-cap-bytes','1','--json'],{cwd:project,encoding:'utf8',timeout:10000});assert.fail('CLI cap must fail');}
  catch(error){assert.equal(error.status,1);const start=String(error.stderr).indexOf('{\n  "ok"');assert(start>=0);cliDenied=JSON.parse(String(error.stderr).slice(start));}
  assert.equal(cliDenied.error.code,'E_STORAGE_CAP_EXCEEDED');
  await assert.rejects(readFile(join(project,`.artifacts/runs/${cliRunId}/checkpoints/oversized-cli/checkpoint.json`)),{code:'ENOENT'});

  const report=await call('probefn_report_export',{sessionId,format:'json',artifactOnly:true});
  assert.equal(JSON.parse(await readFile(join(project,report.reportPath),'utf8')).schemaVersion,'1.0');
  const files=[];
  async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else files.push(path);}}
  await walk(join(project,'.artifacts'));
  const pngs=files.filter(path=>path.endsWith('.png'));assert(pngs.length>0);
  for(const path of pngs)assert.equal((await readFile(path)).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const doms=files.filter(path=>path.endsWith('/dom.json'));assert(doms.length>0);
  const snapshots=await Promise.all(doms.map(async path=>JSON.parse(await readFile(path,'utf8'))));
  assert(snapshots.some(snapshot=>snapshot.html.includes('<p id="result">Action completed</p>')));
  for(const kind of ['ax.json','layout.json','styles.json'])assert(files.some(path=>path.endsWith('/'+kind)),kind);
  await call('probefn_session_stop',{sessionId});started=false;
  execFileSync(bin,['session','stop','--session',cliSessionId,'--json'],{cwd:project,encoding:'utf8',timeout:10000});cliSessionId=undefined;
  const reopened=new ArtifactStore({repoRoot:project});
  const sink=reopened.createEventSink('installed_browser_run','cap-proof','events');
  const appends=[];for(let i=0;i<7;i++)appends.push(await sink.append({sequence:i}));
  assert(appends[3].warning.includes('rollover'));assert(appends[6].warning.includes('rollover'));
  const records=[];
  for(const relative of [...new Set(appends.map(result=>result.relativePath))]){
    const lines=(await readFile(join(project,relative),'utf8')).trim().split('\n').map(JSON.parse);assert(lines.length<=3);records.push(...lines);
  }
  assert.deepEqual(records.map(record=>record.sequence),[0,1,2,3,4,5,6]);
  await assert.rejects(reopened.writeArtifact('.artifacts/runs/installed_browser_run/oversized.bin',Buffer.alloc(2097153)),error=>error.code==='E_STORAGE_CAP_EXCEEDED');
  const database=new DatabaseSync(join(project,'.artifacts/.quota.sqlite'));
  const policy=database.prepare('SELECT cap,max_events FROM run_caps WHERE run_id=?').get('installed_browser_run');database.close();
  assert.equal(policy.cap,2097152);assert.equal(policy.max_events,3);
  await writeFile(join(project,'small.config.mjs'),`export default ${JSON.stringify({storageCaps:{maxArtifactBytes:1},devServers:{web:{mode:'spawn',name:'web',command:`'${process.execPath}' app.mjs`,cwd:'.',url}}})}`);
  const tooSmall=await client.callTool({name:'probefn_session_start',arguments:{configPath:'small.config.mjs',sessionId:'too_small',runId:'too_small'}});
  assert.equal(tooSmall.isError,true);assert.equal(tooSmall.structuredContent.error.code,'E_STORAGE_CAP_EXCEEDED');
  assert.equal(tooSmall.structuredContent.error.details.manifestFinalized,false);
  await assert.rejects(readFile(join(project,'.artifacts/runs/too_small/session.json')),{code:'ENOENT'});
  console.log(JSON.stringify({installedCapProof:true,checkpointByteCap:1,runByteCap:policy.cap,eventCap:policy.max_events,eventsPreserved:records.length,rollovers:appends.filter(result=>result.warning).length}));

  const cli=JSON.parse(execFileSync(bin,['report','export','--session',sessionId,'--format','json','--artifact-only','--json'],{cwd:project,encoding:'utf8',timeout:10000}));assert.equal(cli.ok,true);
  await assert.rejects(fetch(url,{signal:AbortSignal.timeout(1000)}));
  const pid=Number(await readFile(join(project,'app.pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
  console.log(JSON.stringify({installedBrowserPassed:true,artifactsBeforeStop:files.length,screenshots:pngs.length,devServerPid:pid,devServerStopped:true}));
} finally {
  if(cliSessionId)try{execFileSync(bin,['session','stop','--session',cliSessionId,'--json'],{cwd:project,encoding:'utf8',timeout:10000});}catch(error){console.error('CLI session cleanup failed',error);process.exitCode=1;}
  if(started)await call('probefn_session_stop',{sessionId}).catch(error=>{console.error('Session cleanup failed',error);process.exitCode=1;});
  await client.close();await transport.close();
  if(process.exitCode)console.error(diagnostics);
}
