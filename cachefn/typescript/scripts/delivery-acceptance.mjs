/** Validate with explicit local prerequisite tarballs, without mutating repository manifests. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const source = fileURLToPath(new URL('../../', import.meta.url));
const prerequisites = { '@mcpfn/core': process.env.MCP_CORE_TARBALL, '@superfunctions/admin': process.env.SHARED_ADMIN_TARBALL };
for (const [name, path] of Object.entries(prerequisites)) {
  if (!path || !existsSync(path)) throw new Error(`Provide local ${name} using MCP_CORE_TARBALL / SHARED_ADMIN_TARBALL`);
}
const temporary = mkdtempSync(join(tmpdir(), 'cachefn-delivery-'));
const run = (command, args, cwd = temporary) => {
  if (command === 'npm' && process.env.NPM_CLI) { command = process.execPath; args = [resolve(process.env.NPM_CLI), ...args]; }
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
};
try {
  for (const name of ['typescript', 'admin']) cpSync(join(source, name), join(temporary, name), {
    recursive: true, filter: path => !/(?:^|\/)(?:node_modules|dist|coverage|\.conduct)(?:\/|$)/.test(path),
  });
  const dependencies = Object.fromEntries(Object.entries(prerequisites).map(([name,path]) => [name, `file:${resolve(path)}`]));
  writeFileSync(join(temporary,'package.json'), JSON.stringify({private:true,workspaces:['typescript','admin'],dependencies}));
  console.log(run('npm',['install','--ignore-scripts','--no-audit','--no-fund']));
  for (const workspace of ['@cachefn/core','@cachefn/admin']) {
    for (const task of ['build','typecheck','test']) console.log(run('npm',['run',task,'--workspace',workspace]));
  }
  console.log(run(process.execPath,['scripts/packed-consumer.mjs'],join(temporary,'typescript')));
  if (process.env.PLAYWRIGHT_MODULE_PATH) console.log(run(process.execPath,['scripts/browser-acceptance.mjs'],join(temporary,'typescript')));
  const consumer=join(temporary,'consumer');mkdirSync(consumer);
  const pack = name => JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',consumer],join(temporary,name)))[0].filename;
  dependencies['@cachefn/core']=`file:./${pack('typescript')}`;
  dependencies['@cachefn/admin']=`file:./${pack('admin')}`;
  writeFileSync(join(consumer,'package.json'),JSON.stringify({private:true,type:'module',dependencies}));
  console.log(run('npm',['install','--ignore-scripts','--omit=dev','--no-audit','--no-fund'],consumer));
  const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));
  for(const[name,version]of Object.entries({'@mcpfn/core':'0.0.6','@superfunctions/admin':'0.1.5','@cachefn/core':'0.0.3','@cachefn/admin':'0.1.0'})) {
    const actual=lock.packages[`node_modules/${name}`];
    if(actual.version!==version || !actual.resolved.startsWith('file:'))throw new Error(`Unexpected package ${name}`);
  }
  console.log(run(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import{CacheFn}from'@cachefn/core';import{createCacheFnDomainAdminService}from'@cachefn/admin';const cache=new CacheFn({name:'packed-admin',namespace:'tenant'});await cache.set('key',42);assert.ok(createCacheFnDomainAdminService({cache,environmentId:'env',namespace:'tenant'}));assert.equal(await cache.get('key'),42);cache.dispose();console.log('Exact local tarballs: CacheFn core/admin runtime passed');`],consumer));
  const audit=JSON.parse(run('npm',['audit','--omit=dev','--json'],consumer));
  console.log('Packed production vulnerabilities:',JSON.stringify(audit.metadata.vulnerabilities));
} catch(error) {
  if(error.stdout)process.stderr.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);throw error;
} finally {rmSync(temporary,{recursive:true,force:true});}
