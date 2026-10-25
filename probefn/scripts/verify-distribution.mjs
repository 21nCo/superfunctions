/** Build the CLI/admin Turbo closure first; installs only private local tarballs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 22 || (major === 22 && minor >= 13), 'ProbeFn requires Node >=22.13');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const directories = new Set();
async function visit(name) {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry?.link) return;
  const directory = entry.resolved;
  if (directories.has(directory)) return;
  directories.add(directory);
  const manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await visit(dependency);
}
await visit('@probefn/cli');
await visit('@probefn/admin');
const directory = await mkdtemp(join(tmpdir(), 'probefn-distribution-'));
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
const npm = (args, cwd) => process.env.PROBEFN_NPM_CLI ? run(process.execPath, [process.env.PROBEFN_NPM_CLI, ...args], cwd) : run('npm', args, cwd);
try {
  const tarballs = [];
  for (const folder of directories) {
    const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', directory], join(root, folder)));
    if (folder.startsWith('probefn/')) {
      assert(packed.files.some(file => file.path === 'dist/index.js'), folder);
      assert(packed.files.some(file => file.path === 'dist/index.d.ts'), folder);
      assert(!packed.files.some(file => /(^|\/)(src|test)\//.test(file.path)), folder);
    }
    tarballs.push(join(directory, packed.filename));
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', devDependencies: { typescript: '^5.8.0', '@types/node': '^22.14.0', ...(process.env.PROBEFN_PLAYWRIGHT_VERSION ? { playwright: process.env.PROBEFN_PLAYWRIGHT_VERSION } : {}) } }));
  npm(['install', '--no-fund', ...tarballs]);
  const fixture = `
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,access} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {loadConfig,validateConfig} from '@probefn/contracts/config';
import {createProbeFnAdminAdapter,createProbeFnDomainAdminService} from '@probefn/admin';
const project=join(process.cwd(),'consumer-project');await mkdir(project);
await writeConfig();
async function writeConfig(){const {writeFile}=await import('node:fs/promises');await writeFile(join(project,'probefn.config.ts'),'export default { projectName:"installed-project" };');}
assert.equal((await loadConfig('probefn.config.ts',{cwd:project})).projectName,'installed-project');
const parsedConfig=validateConfig({deterministicDefaults:{viewport:{width:800}},devServers:{web:{mode:'attach',name:' web ',url:'http://localhost:3000'}}});
assert.equal(parsedConfig.deterministicDefaults.viewport.height,900);
assert.equal(parsedConfig.deterministicDefaults.locale,'en-US');
assert.equal(parsedConfig.devServers.web.name,'web');
assert.equal(parsedConfig.devServers.web.timeoutMs,120000);
assert.throws(()=>validateConfig({storageCaps:{unknown:1}}));
assert.throws(()=>validateConfig({devServers:{web:null}}));
const scope={installationId:'i',workspaceId:'w',projectId:'p',environmentId:'e'};
const context={scope,actor:{id:'operator',type:'user',permissions:['*']},requestId:'r',correlationId:'c',source:'console',idempotencyKey:'key',confirmationToken:'test-confirmation'};
const admin=createProbeFnAdminAdapter(createProbeFnDomainAdminService({bindings:[{scope,repoRoot:project,artifactRoot:'.artifacts'}]}));
const deterministic={enabled:true,viewport:{width:1280,height:720},locale:'en-US',timezone:'UTC',colorScheme:'light',reducedMotion:'reduce',animationPolicy:'freeze',networkIdleMs:0};
const initialized=await admin.execute('probefn.sessions.initialize',{sessionId:'installed',runId:'installed_run',mode:'debug',browser:'chromium',deterministic,startedAt:new Date().toISOString(),resolvedUrl:'http://127.0.0.1/'},context);
assert.equal(initialized.data.item.status,'starting');
assert.equal((await admin.execute('probefn.sessions.get',{id:'installed'},context)).data.item.sessionId,'installed');
await assert.rejects(admin.execute('probefn.sessions.get',{id:'installed'},{...context,scope:{...scope,environmentId:'other'}}));
const bin=join(process.cwd(),'node_modules/.bin/probefn');
const cli=JSON.parse(execFileSync(bin,['report','export','--session','installed','--format','json','--artifact-only','--json'],{cwd:project,encoding:'utf8',timeout:10000,env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH}}));
assert.equal(cli.ok,true);assert.equal(cli.data.reportPath,'.artifacts/runs/installed_run/report.json');
assert.equal(JSON.parse(await readFile(join(project,cli.data.reportPath),'utf8')).schemaVersion,'1.0');
const transport=new StdioClientTransport({command:bin,args:['mcp','serve','--stdio'],cwd:project,stderr:'pipe'});
let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
const client=new Client({name:'installed-probe-consumer',version:'1.0.0'});
try{
 await client.connect(transport);
 const listed=await client.listTools();assert.equal(listed.tools.length,16);
 const missing=await client.callTool({name:'probefn_report_export',arguments:{}});
 assert.equal(missing.isError,true);
 assert.equal(missing.structuredContent.error.code,'E_MCP_INVALID_ARGS');
 assert.equal(missing.structuredContent.error.message,'Missing required field sessionId.');
 const malformed=await client.callTool({name:'probefn_report_export',arguments:{sessionId:{secret:'installed-private-input'}}});
 assert.equal(malformed.isError,true);
 assert(!JSON.stringify(malformed).includes('installed-private-input'));
 assert(!malformed.structuredContent.error.message.includes('Missing required'));

 const result=await client.callTool({name:'probefn_report_export',arguments:{sessionId:'installed',format:'json',artifactOnly:true}});
 assert.equal(result.isError,false,JSON.stringify(result));
 assert.equal(result.structuredContent.ok,true);
 assert.equal(result.structuredContent.data.reportPath,cli.data.reportPath);
}finally{await client.close();await transport.close();}
assert(stderr.includes('stdio ready'));
for(const misplaced of ['node_modules/.artifacts','node_modules/@probefn/.artifacts','node_modules/@probefn/cli/.artifacts']) await assert.rejects(access(join(process.cwd(),misplaced)));
console.log('Installed CLI bin, MCP stdio, config loader and scoped admin persisted-report consumer passed');
`;
  await writeFile(join(directory, 'consumer.mjs'), fixture);
  process.stdout.write(run(process.execPath, ['consumer.mjs']));
  await writeFile(join(directory, 'event-journal-consumer.mjs'), await readFile(join(root, 'probefn/scripts/installed-event-journal-consumer.mjs')));
  process.stdout.write(run(process.execPath, ['event-journal-consumer.mjs']));
  await writeFile(join(directory, 'scratch-consumer.mjs'), await readFile(join(root, 'probefn/scripts/installed-scratch-consumer.mjs')));
  process.stdout.write(run(process.execPath, ['scratch-consumer.mjs']));
  if (process.argv.includes('--browser')) {
    await writeFile(join(directory, 'browser-consumer.mjs'), await readFile(join(root, 'probefn/scripts/installed-browser-consumer.mjs')));
    process.stdout.write(run(process.execPath, ['browser-consumer.mjs']));
  }
  await writeFile(join(directory, 'consumer.mts'), `import {executeCli} from '@probefn/cli'; import {runMcpCli} from '@probefn/mcp-server'; import {createProbeFnAdminAdapter} from '@probefn/admin'; import {loadConfig} from '@probefn/contracts/config'; import {ArtifactStore} from '@probefn/storage'; const health: Promise<{failed:boolean}> = new ArtifactStore({repoRoot:'.'}).recoverEventWrites('run'); const store = new ArtifactStore({repoRoot:'.'}); const scratch = store.recoverTraceScratch('run'); const reconcile: Promise<string> = store.reconcileTraceScratch('run','id'); const ack: Promise<void> = store.acknowledgeTraceScratch('run','.artifacts/runs/run/trace.zip'); void [executeCli,runMcpCli,createProbeFnAdminAdapter,loadConfig,health,scratch,reconcile,ack];`);
  process.stdout.write(run(process.execPath, ['node_modules/typescript/bin/tsc','--strict','--noEmit','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2023','consumer.mts']));
  let audit;
  try { audit = npm(['audit','--omit=dev','--json']); } catch (error) { audit = String(error.stdout); }
  const auditReport = JSON.parse(audit);
  assert.equal(auditReport.metadata?.vulnerabilities.total, 0, JSON.stringify(auditReport.vulnerabilities));
  console.log(JSON.stringify({ passed: true, installedPackages: tarballs.length, productionAudit: auditReport.metadata?.vulnerabilities, vulnerabilities: auditReport.vulnerabilities }));
} finally {
  await rm(directory, { recursive: true, force: true });
  console.log('Owned installed consumer removed');
}
