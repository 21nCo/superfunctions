import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'logfn-admin-packed-'));
const npm = (args, cwd = temporary) => execFileSync(process.env.NPM_CLI ? process.execPath : 'npm', process.env.NPM_CLI ? [process.env.NPM_CLI, ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const tarballs = ['mcpfn/core', 'packages/admin', 'logfn/typescript', 'logfn/admin'].map(path => {
    const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], join(root, path)));
    assert.ok(pack.files.every(file => !file.path.includes('.test.')));
    return join(temporary, pack.filename);
  });
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs]);
  npm(['install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '@types/node@20']);
  writeFileSync(join(temporary, 'consumer.mts'), `import {createLogFnAdminService,createLogFnAdminAdapter,createLogFnAdminClient} from '@logfn/admin';
import {createLogger} from '@logfn/core';
const service=createLogFnAdminService(createLogger({name:'typed',sinks:[]}),{installationId:'i',workspaceId:'w',projectId:'p',environmentId:'e'});
createLogFnAdminAdapter(service); void createLogFnAdminClient;`);
  writeFileSync(join(temporary, 'consumer.cts'), `async function load(){const {createLogFnAdminService}=await import('@logfn/admin'); return createLogFnAdminService;}void load;`);
  for (const mode of ['Node16', 'NodeNext']) execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', mode, '--moduleResolution', mode, 'consumer.mts', 'consumer.cts'], { cwd: temporary, stdio: 'pipe' });
  writeFileSync(join(temporary, 'smoke.mjs'), `import assert from 'node:assert/strict';
import {createLogFnAdminService,createLogFnAdminAdapter} from '@logfn/admin';
import {createLogger} from '@logfn/core';
import {createAdminDispatcher,createAdminRegistry,createAdminCapabilityAdapter,defineAdminCapability,MemoryAdminAuditSink,MemoryAdminIdempotencyStore} from '@superfunctions/admin';
const scope={installationId:'i',workspaceId:'w',projectId:'p',environmentId:'e'};
const context={scope,actor:{id:'operator',permissions:['logfn.events.emit','logfn.sinks.flush']},requestId:'r',source:'rest'};
const events=[];let flushed=0;
const logger=createLogger({name:'packed',sinks:[Object.assign(batch=>events.push(...batch),{flush:async()=>{flushed++;}})]});
const adapter=createLogFnAdminAdapter(createLogFnAdminService(logger,scope));
const owner=createAdminCapabilityAdapter(defineAdminCapability({schemaVersion:'1.0',id:'watchfn',displayName:'WatchFn',version:'1.0.0',description:'Owner fixture',category:'observability',availability:'optional-product',scopeLevels:['organization'],resources:[],operations:[],navigation:[]}),{});
const dispatcher=createAdminDispatcher({registry:createAdminRegistry({adapters:[owner,adapter],enabledModules:['watchfn','logfn']}),audit:new MemoryAdminAuditSink(),idempotency:new MemoryAdminIdempotencyStore()});
assert.equal((await dispatcher.dispatch({operationId:'logfn.events.emit',input:{level:'warn',message:'packed'},context})).ok,true);
assert.equal(events[0].ctx.adminActorId,'operator');
assert.equal((await dispatcher.dispatch({operationId:'logfn.events.emit',input:{level:'constructor',message:'invalid'},context})).ok,false);
const flushResult=await dispatcher.dispatch({operationId:'logfn.sinks.flush',input:{},context:{...context,requestId:'flush',idempotencyKey:'flush-1'}});assert.equal(flushResult.ok,true,JSON.stringify(flushResult));assert.equal(flushed,1);
console.log('packed admin dispatcher',process.version);`);
  writeFileSync(join(temporary, 'smoke.cjs'), `import('@logfn/admin').then(api=>{if(typeof api.createLogFnAdminService!=='function')throw new Error('missing API');}).catch(error=>{console.error(error);process.exitCode=1;});`);
  for (const version of ['20.0.0', '22.23.3']) {
    console.log(npm(['exec', '--yes', `--package=node@${version}`, '--', 'node', 'smoke.mjs']).trim());
    npm(['exec', '--yes', `--package=node@${version}`, '--', 'node', 'smoke.cjs']);
  }
  const audit = JSON.parse(npm(['audit', '--omit=dev', '--json']));
  assert.equal(audit.metadata.vulnerabilities.total, 0);
  console.log('admin declarations, dynamic CJS and runtime audit passed');
} finally { rmSync(temporary, { recursive: true, force: true }); }
