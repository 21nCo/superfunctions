/** Copied into the fresh tarball consumer by verify-distribution.mjs --browser. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

const project = join(process.cwd(), 'browser-project');
await mkdir(project);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const url = `http://127.0.0.1:${port}`;
const html = `<!doctype html><html><body><h1>Installed browser fixture</h1><button id="change" onclick="localStorage.setItem('result','Action completed');document.querySelector('#result').textContent=localStorage.getItem('result')">Change</button><p id="result">Waiting</p><script>document.querySelector('#result').textContent=localStorage.getItem('result')||'Waiting'</script></body></html>`;
await writeFile(join(project, 'app.mjs'), `import {createServer} from 'node:http'; import {writeFileSync} from 'node:fs'; writeFileSync('app.pid',String(process.pid)); createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(${JSON.stringify(html)});}).listen(${port},'127.0.0.1',()=>console.log('Ready ${url}'));`);
await writeFile(join(project, 'probefn.config.mjs'), `export default ${JSON.stringify({projectName:'installed-browser',devServers:{web:{mode:'spawn',name:'web',command:`'${process.execPath}' app.mjs`,cwd:'.',url,readyPattern:'Ready (https?://[^\\s]+)',timeoutMs:10000}},deterministicDefaults:{networkIdleMs:100}})};`);
const executable = chromium.executablePath();
console.log(JSON.stringify({engine:'chromium',executable,version:execFileSync(executable,['--version'],{encoding:'utf8',timeout:10000}).trim()}));
const bin = join(process.cwd(), 'node_modules/.bin/probefn');
const transport = new StdioClientTransport({command:bin,args:['mcp','serve','--stdio'],cwd:project,stderr:'pipe'});
let diagnostics=''; transport.stderr?.on('data',chunk=>{diagnostics+=chunk;});
const client = new Client({name:'installed-browser-acceptance',version:'1.0.0'});
let started = false;
async function call(name,args){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.structuredContent?.ok,true,JSON.stringify(result));return result.structuredContent.data;}
const sessionId='installed_browser';
try {
  await client.connect(transport);
  console.log(JSON.stringify({started:await call('probefn_session_start',{configPath:'probefn.config.mjs',sessionId,runId:'installed_browser_run'})}));started=true;
  await call('probefn_page_open',{sessionId,url});
  await call('probefn_page_act',{sessionId,action:'click',selector:'#change'});
  const checkpoint=await call('probefn_checkpoint_create',{sessionId,name:'after-action',includeStyles:true});
  console.log(JSON.stringify({checkpoint}));
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
  const cli=JSON.parse(execFileSync(bin,['report','export','--session',sessionId,'--format','json','--artifact-only','--json'],{cwd:project,encoding:'utf8',timeout:10000}));assert.equal(cli.ok,true);
  await assert.rejects(fetch(url,{signal:AbortSignal.timeout(1000)}));
  const pid=Number(await readFile(join(project,'app.pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
  console.log(JSON.stringify({installedBrowserPassed:true,artifacts:files.length,screenshots:pngs.length,devServerPid:pid,devServerStopped:true}));
} finally {
  if(started)await call('probefn_session_stop',{sessionId}).catch(error=>{console.error('Session cleanup failed',error);process.exitCode=1;});
  await client.close();await transport.close();
  if(process.exitCode)console.error(diagnostics);
}
