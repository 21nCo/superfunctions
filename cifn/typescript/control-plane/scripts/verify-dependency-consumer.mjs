/** Fresh production tarballs, public CJS/ESM APIs and actual TestFn glob execution. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'cifn-dependency-consumer-'));
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
  await writeFile(join(directory,'package.json'),JSON.stringify({name:'cifn-owned-dependency-consumer',version:'1.0.0',private:true,type:'module',dependencies},null,2));
  run('npm',['install','--omit=dev','--no-fund']);
  const auditReport=async name=>{
    let output;try{output=run('npm',['audit','--omit=dev','--json']);}catch(error){if(!error.stdout)throw error;output=error.stdout;}
    const report=JSON.parse(output);await writeFile(join(tmpdir(),name),JSON.stringify(report,null,2));return report;
  };
  const audit=await auditReport('cifn-dependency-production-audit.json');
  assert.equal(audit.metadata.vulnerabilities.total,0);
  const productionLock=JSON.parse(await readFile(join(directory,'package-lock.json'),'utf8'));
  for(const name of ['uuid','braces','micromatch','fast-glob'])assert.ok(!Object.keys(productionLock.packages).some(path=>path.endsWith('/node_modules/'+name)||path==='node_modules/'+name),`${name} absent from production closure`);
  // Install only the consumer's selected test framework after recording production closure.
  run('npm',['install','--save-dev','vitest@4.1.12','--no-fund']);
  await mkdir(join(directory,'tests'));
  await writeFile(join(directory,'tests/a.test.js'),"import {it,expect} from 'vitest';it('first',()=>expect(1).toBe(1));");
  await writeFile(join(directory,'tests/b.spec.ts'),"import {it,expect} from 'vitest';it('second',()=>expect(2).toBe(2));");
  await writeFile(join(directory,'tests/ignored.js'),"throw new Error('must not discover');");
  const body=`
    const assert=(await import('node:assert/strict')).default;
    assert.equal(typeof control.createApp,'function');
    const original=process.cwd();
    const sync=runner.executeTestFnRun({workspace:'/must-not-open'});assert.equal(sync.success,false);assert.equal(process.cwd(),original);
    const result=await runner.executeTestFnRunAsync({workspace:original,testPattern:'./tests/**/*.{test,spec}.{ts,js}',parallel:1,timeout:15000});
    assert.equal(result.success,true,result.error);assert.ok(result.lines.includes('Tests completed: 2 total'));assert.equal(process.cwd(),original);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const workspaces = ['one', 'two'].map(name => path.join(original, name));
    for (const workspace of workspaces) {
      await fs.mkdir(path.join(workspace, 'tests'), {recursive:true});
      await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({type:'module'}));
      await fs.writeFile(path.join(workspace, 'tests/owned.test.js'), "import {it,expect} from 'vitest';import {writeFileSync} from 'node:fs';it('owned',()=>{writeFileSync('witness',process.cwd());expect(process.cwd()).toBe("+JSON.stringify(workspace)+");});");
    }
    const pending = workspaces.map(workspace => runner.executeTestFnRunAsync({workspace,reporter:'json',timeout:15000}));
    process.chdir(workspaces[0]);
    try {
      const concurrent = await Promise.all(pending);
      assert.deepEqual(concurrent.map(result => result.success), [true,true]);
      assert.equal(process.cwd(),workspaces[0]);
      for (const workspace of workspaces) {
        assert.equal(await fs.readFile(path.join(workspace,'witness'),'utf8'),workspace);
        await fs.access(path.join(workspace,'testfn-results.json'));
      }
    } finally { process.chdir(original); }

  `;
  await writeFile(join(directory,'consumer.cjs'),`const control=require('@cifn/control-plane');const runner=require('@cifn/runner');(async()=>{${body}})().catch(error=>{console.error(error);process.exitCode=1});`);
  await writeFile(join(directory,'consumer.mjs'),`import * as control from '@cifn/control-plane';import * as runner from '@cifn/runner';${body}`);
  run(process.execPath,['consumer.cjs']);run(process.execPath,['consumer.mjs']);
  const finalAudit=await auditReport('cifn-dependency-framework-audit.json');assert.equal(finalAudit.metadata.vulnerabilities.total,0);
  console.log(JSON.stringify({passed:true,productionAudit:0,productionPackages:packages.size,cjsAndEsmActualGlobExecution:true,concurrentWorkspaceIsolation:true}));
} finally {await rm(directory,{recursive:true,force:true});}
