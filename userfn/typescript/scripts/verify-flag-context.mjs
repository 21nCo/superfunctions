/** Fresh packed SDK/admin runtime and declaration acceptance; builds must already exist. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'userfn-flag-consumer-'));
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
try {
  const tarballs = [];
  for (const folder of ['mcpfn/core', 'packages/admin', 'userfn/typescript', 'userfn/admin']) {
    const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', directory], join(root, folder)));
    tarballs.push(join(directory, packed.filename));
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs, 'typescript@5.6.3', '@types/node@22']);
  await writeFile(join(directory, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import { UserFnClient } from 'userfn';
import { MemoryUserFnOperatorStore, UserFnOperatorService } from 'userfn/operator';
import { createUserFnAdminAdapter, createUserFnOperatorAdminService, userFnAdminCapability } from '@userfn/admin';
import { validateAdminValue } from '@superfunctions/admin';
const gate = { key:'gate', enabled:true, defaultValue:false, rules:[], variations:[], environmentOverrides:{production:{defaultValue:true}} };
const target = { key:'target', enabled:true, defaultValue:'base', rules:[], variations:[], prerequisites:[{key:'gate',expectedValue:true}], environmentOverrides:{production:{defaultValue:0}} };
const client = new UserFnClient({apiKey:'unused',environment:'production'}); client.setFlags([gate,target]);
assert.equal(client.getFlag('target','fallback'),0);
const disabled = new UserFnClient({apiKey:'unused'}); disabled.setFlags([gate,target]); assert.equal(disabled.getFlag('target','fallback'),'fallback');
const scope = {installationId:'i',workspaceId:'w',projectId:'p',environmentId:'production'};
const context = {scope,actor:{id:'a',permissions:['*']},requestId:'r',source:'console',idempotencyKey:'id',confirmationToken:'confirmed'};
const store = new MemoryUserFnOperatorStore(); const adapter = createUserFnAdminAdapter(createUserFnOperatorAdminService(new UserFnOperatorService(store)));
const operation=userFnAdminCapability.operations.find(value=>value.id==='userfn.flags.save');
assert.deepEqual(validateAdminValue(operation.inputSchema,{flag:target}),[]);
const saved=await adapter.invoke('userfn.flags.save',{flag:target},context);assert.deepEqual(saved.data.item,target);
assert.deepEqual(validateAdminValue(operation.outputSchema,saved.data),[]);
const result=await adapter.invoke('userfn.flags.set-enabled',{id:'target',enabled:false},context);
assert.deepEqual(result.data.item,{...target,enabled:false});
assert.deepEqual((await adapter.invoke('userfn.flags.list',{},context)).data.items,[{...target,enabled:false}]);
console.log('Packed ESM SDK/admin flag context and schema round trip passed');
`);
  await writeFile(join(directory, 'runtime.cjs'), `
const assert=require('node:assert/strict');const {UserFnClient}=require('userfn');
const client=new UserFnClient({apiKey:'unused',environment:'test'});
client.setFlags([{key:'gate',enabled:true,defaultValue:false,rules:[],variations:[],environmentOverrides:{test:{defaultValue:true}}},{key:'target',enabled:true,defaultValue:'enabled',rules:[],variations:[],prerequisites:[{key:'gate',expectedValue:true}]}]);
assert.equal(client.getFlag('target','disabled'),'enabled');console.log('Packed CJS SDK flag context passed');
`);
  const consumer = `import { UserFnClient, type FlagConfig, type FlagPrerequisite, type FlagEnvironmentOverride } from 'userfn';
import { MemoryUserFnOperatorStore } from 'userfn/operator';
new MemoryUserFnOperatorStore();
const prerequisite:FlagPrerequisite={key:'gate',expectedValue:false};const override:FlagEnvironmentOverride={defaultValue:0,defaultVariationId:null,rules:[]};
const flag:FlagConfig={key:'target',enabled:true,defaultValue:false,variations:[],rules:[],prerequisites:[prerequisite],environmentOverrides:{test:override}};
const client=new UserFnClient({apiKey:'unused',environment:'test'});client.setFlags([flag]);client.getFlag('target',false);
`;
  await writeFile(join(directory, 'consumer.mts'), consumer);
  await writeFile(join(directory, 'consumer.cts'), consumer);
  process.stdout.write(run(process.execPath, ['runtime.mjs']));
  process.stdout.write(run(process.execPath, ['runtime.cjs']));
  process.stdout.write(run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'consumer.mts', 'consumer.cts']));
  console.log('Fresh packed ESM/CJS declaration consumers passed without skipLibCheck or peer bypass');
} finally { await rm(directory, { recursive: true, force: true }); }
