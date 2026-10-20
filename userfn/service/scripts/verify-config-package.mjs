/** Build dependencies first; validates fresh installed artifacts, not source aliases. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'userfn-config-package-'));
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const npm = (args, cwd) => process.env.USERFN_NPM_CLI ? run(process.execPath, [process.env.USERFN_NPM_CLI, ...args], cwd) : run('npm', args, cwd);
try {
  const tarballs = [];
  for (const folder of ['packages/observability', 'packages/auth', 'packages/http', 'packages/db', 'userfn/typescript', 'userfn/service']) {
    const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', directory], join(root, folder))); tarballs.push(join(directory, pack.filename));
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs, 'typescript@5.6.3', '@types/node@22']);
  const fixture = `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, verify } from 'node:crypto';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createUserFnService } from '@userfn/service';
import { UserFnClient } from 'userfn';
const keys=generateKeyPairSync('ed25519');
const service=createUserFnService({database:memoryAdapter(),auth:{async authenticate(request){return request.headers.get('authorization')==='Bearer key'?{id:'key',type:'api-key',subject:{actorId:'publisher',actorType:'api-key',tenantId:'tenant'},scopes:['userfn:config:read','userfn:config:write']}:null}},flagConfigSigning:{privateKey:keys.privateKey,keyId:'key-1'}});
const server=createServer(async(incoming,outgoing)=>{try{const chunks=[];for await(const chunk of incoming)chunks.push(chunk);const response=await service.router.handle(new Request('http://localhost'+incoming.url,{method:incoming.method,headers:incoming.headers,...(incoming.method==='PUT'?{body:Buffer.concat(chunks)}:{})}));outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));}catch{outgoing.writeHead(500);outgoing.end('failure')}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 const endpoint='http://127.0.0.1:'+server.address().port+'/config/production';
 const response=await fetch(endpoint,{method:'PUT',headers:{authorization:'Bearer key','if-none-match':'*','content-type':'application/json'},body:JSON.stringify({flags:[{key:'feature',enabled:true,defaultValue:false,variations:[],rules:[],environmentOverrides:{production:{defaultValue:true}}}],segments:[]})});
 assert.equal(response.status,201);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(verify(null,bytes,keys.publicKey,Buffer.from(response.headers.get('x-userfn-signature'),'base64url')),true);
 const snapshot=JSON.parse(bytes);assert.equal(snapshot.tenantId,'tenant');assert.equal(snapshot.environment,'production');assert.equal(snapshot.algorithm,'Ed25519');assert.equal(snapshot.keyId,'key-1');
 const client=new UserFnClient({apiKey:'key',endpoint:'http://127.0.0.1:'+server.address().port,environment:'production',config:{tenantId:'tenant',trustedKeys:{'key-1':keys.publicKey.export({type:'spki',format:'der'}).toString('base64url')},allowInsecureHttp:true}});assert.equal(await client.refreshConfig(),true);assert.equal(client.getFlag('feature'),true);assert.equal(await client.refreshConfig(),false);client.closeConfig();
 assert.equal((await fetch(endpoint,{headers:{authorization:'Bearer key','if-none-match':response.headers.get('etag')}})).status,304);
 console.log('Fresh installed service/shared/SDK signed HTTP publication and conditional fetch passed');
}finally{await new Promise(resolve=>server.close(resolve));}
`;
  await writeFile(join(directory, 'runtime.mjs'), fixture);
  process.stdout.write(run(process.execPath, ['runtime.mjs']));
  await writeFile(join(directory, 'consumer.mts'), `import { generateKeyPairSync } from 'node:crypto';
import { createUserFnService, type FlagConfigSigningOptions } from '@userfn/service';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
const signing:FlagConfigSigningOptions={privateKey:generateKeyPairSync('ed25519').privateKey,keyId:'key'};
const service=createUserFnService({database:memoryAdapter(),auth:{async authenticate(){return null}},flagConfigSigning:signing});
service.router.handle(new Request('http://localhost/config/production'));
`);
  process.stdout.write(run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'consumer.mts']));
  console.log('Fresh installed strict service declarations passed without skipLibCheck or peer bypass');
} finally { await rm(directory, { recursive: true, force: true }); }
