/** Pack built local prerequisites and validate in a fresh consumer. No registry publication. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const execute = promisify(execFile);
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prerequisiteRoot = process.env.CACHEFN_TESTFN_WORKTREE || resolve(directory, '../..');
const consumer = await mkdtemp(join(tmpdir(), 'cachefn-testfn-packed-'));
const run = async (command, args, cwd = consumer, env = process.env) => {
  if (command === 'npm' && process.env.CACHEFN_NPM_CLI) { args = [process.env.CACHEFN_NPM_CLI, ...args]; command = process.execPath; }
  try { return (await execute(command,args,{cwd,env,timeout:180000,maxBuffer:8*1024*1024})).stdout; }
  catch(error) { if(error.stdout)process.stderr.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);throw error; }
};
try {
  const artifacts=[];
  for (const path of [directory,join(prerequisiteRoot,'testfn/typescript'),join(prerequisiteRoot,'packages/db'),join(prerequisiteRoot,'packages/observability')]) {
    const [packed]=JSON.parse(await run('npm',['pack','--json','--ignore-scripts','--pack-destination',consumer],path));
    const file=join(consumer,packed.filename);
    artifacts.push({name:packed.name,version:packed.version,filename:packed.filename,sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
  }
  await writeFile(join(consumer,'package.json'),JSON.stringify({name:'cachefn-testfn-consumer',private:true,type:'module',dependencies:{...Object.fromEntries(artifacts.map(item=>[item.name,`file:./${item.filename}`])),vitest:'4.1.11','drizzle-orm':'0.45.4'}}));
  console.log('Installing isolated packed consumer');
  await run('npm',['install','--no-audit','--no-fund']);
  const lock=JSON.parse(await readFile(join(consumer,'package-lock.json'),'utf8'));
  for(const artifact of artifacts)assert.equal(lock.packages[`node_modules/${artifact.name}`].resolved,`file:${artifact.filename}`);
  const result=await run(process.execPath,[join(directory,'scripts/testfn-acceptance.mjs')],consumer,{...process.env,CACHEFN_CONSUMER_ROOT:consumer});
  console.log(result.trim());
  console.log(JSON.stringify({node:process.version,npm:(await run('npm',['--version'])).trim(),artifacts,vitest:lock.packages['node_modules/vitest'].version,drizzle:lock.packages['node_modules/drizzle-orm'].version},null,2));
} finally {await rm(consumer,{recursive:true,force:true});}
