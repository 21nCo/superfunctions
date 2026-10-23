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
  for (const name of ['@cifn/runner', '@cifn/control-plane']) {
    const installed = await realpath(join(directory, 'node_modules', name));
    assert.ok(installed.startsWith(moduleRoot + '/'), 'Consumer must use its installed package');
  }
  await writeFile(join(directory, 'consumer.cjs'), "const assert=require('node:assert/strict');assert.equal(typeof require('@cifn/runner').RemoteRunner,'function');assert.equal(typeof require('@cifn/control-plane').createApp,'function');");
  await writeFile(join(directory, 'consumer.mjs'), "import assert from 'node:assert/strict';import * as runner from './node_modules/@cifn/runner/dist/index.mjs';import * as control from './node_modules/@cifn/control-plane/dist/index.mjs';assert.equal(typeof runner.RemoteRunner,'function');assert.equal(typeof control.createApp,'function');");
  run(process.execPath, ['consumer.cjs']);
  run(process.execPath, ['consumer.mjs']);
  const receipt = run(process.execPath, ['node_modules/@cifn/control-plane/scripts/verify-remote-logs.mjs']);
  process.stdout.write(receipt);
  let auditOutput;
  try { auditOutput = run('npm', ['audit', '--omit=dev', '--json']); }
  catch (error) { if (!error.stdout) throw error; auditOutput = error.stdout; }
  const audit = JSON.parse(auditOutput);
  assert.equal(audit.metadata.vulnerabilities.total, 0);
  console.log(JSON.stringify({passed:true, installedPackages:packages.size, cjs:true, esm:true, productionAudit:0, node:process.version}));
} finally { await rm(directory, {recursive:true, force:true}); }
