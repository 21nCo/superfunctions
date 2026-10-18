/** Isolated published-package contract and runtime dependency validation. Build first. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'compfn-packed-consumer-'));
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'] });
try {
  const dependencies = {};
  for (const path of ['packages/observability','packages/db','packages/http','mcpfn/core','packages/admin','compfn','compfn/admin']) {
    const [pack] = JSON.parse(run('npm', ['pack','--json','--ignore-scripts','--pack-destination', directory], join((path === 'mcpfn/core' || path === 'packages/admin') ? (process.env.SHARED_RUNTIME_ROOT ?? root) : root,path)));
    dependencies[pack.name] = `file:${join(directory,pack.filename)}`;
  }
  dependencies['drizzle-orm'] = '^0.45.4';
  writeFileSync(join(directory,'package.json'),JSON.stringify({private:true,type:'module',dependencies,devDependencies:{typescript:'5.9.3','@types/node':'22'}}));
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund']);
  writeFileSync(join(directory,'consumer.mts'), `import {compFn,loadBundle,createAuthfnAdapter} from 'compfn';
import {memoryAdapter} from '@superfunctions/db/adapters/memory';
import {createCompFnDomainAdminService} from '@compfn/admin';
const api=compFn({database:memoryAdapter()});
void api.export.auditorPack(); void api.evidence.list();
void loadBundle(api,{framework:{name:'f',requirements:[]},controls:[{id:'local',name:'n',description:'d',category:'c'}]});
void createAuthfnAdapter({client:{getMfaStatus:async()=>({enforced:true})}});
void createCompFnDomainAdminService({compfn:api,scope:{workspaceId:'w'}});`);
  writeFileSync(join(directory,'consumer.cts'), `async function consume(){ const {compFn}=await import('compfn'); const {memoryAdapter}=await import('@superfunctions/db/adapters/memory'); const {createCompFnDomainAdminService}=await import('@compfn/admin');const api=compFn({database:memoryAdapter()});return createCompFnDomainAdminService({compfn:api,scope:{workspaceId:'w'}}); } void consume;`);
  for (const mode of ['Node16','NodeNext']) {
    run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--strict','--target','ES2022','--module',mode,'--moduleResolution',mode,'consumer.mts','consumer.cts']);
    console.log(`${mode} ESM and CJS dynamic consumers passed`);
  }
  writeFileSync(join(directory,'smoke.mjs'), `import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';import {compFn,loadBundle} from 'compfn';import {memoryAdapter} from '@superfunctions/db/adapters/memory';import {createCompFnDomainAdminService} from '@compfn/admin';const require=createRequire(import.meta.url);const db=memoryAdapter();await db.initialize();const api=compFn({database:db});const bundle=JSON.parse(readFileSync(require.resolve('compfn/bundles/soc2-type2.json'),'utf8'));const loaded=await loadBundle(api,bundle);assert.equal(loaded.ok,true,JSON.stringify(loaded));assert.equal(loaded.result.controls.length,43);assert.equal(typeof createCompFnDomainAdminService({compfn:api,scope:{workspaceId:'w'}}).listControls,'function');await db.close();console.log('Packed bundle + SSR imports passed',process.version);`);
  const results=[];
  for (const version of ['18.18.0','20','22']) {
    const result=spawnSync('npx',['--yes',`--package=node@${version}`,'node','smoke.mjs'],{cwd:directory,encoding:'utf8'});
    results.push({version,status:result.status,stdout:result.stdout,stderr:result.stderr});
    console.log(JSON.stringify(results.at(-1)));
  }
  const audit=spawnSync('npm',['audit','--omit=dev','--json'],{cwd:directory,encoding:'utf8'});
  writeFileSync(join(directory,'audit.json'),audit.stdout);
  writeFileSync(join(directory,'results.json'),JSON.stringify(results,null,2));
  console.log('Runtime audit:',JSON.parse(audit.stdout).metadata);
  console.log(`Packed consumer retained: ${directory}`);
  if(audit.status || results.some(r=>r.version !== '18.18.0' && r.status)) process.exitCode=1;
} catch(error) {
  console.error(`Retained consumer: ${directory}`);
  if(error.stdout) process.stderr.write(error.stdout);
  if(error.stderr) process.stderr.write(error.stderr);
  throw error;
}
