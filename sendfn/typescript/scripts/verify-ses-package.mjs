import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'sendfn-ses-consumer-'));
const npm = process.env.SENDFN_NPM_CLI;
const runNpm = (args, cwd) => execFileSync(npm ? process.execPath : 'npm', npm ? [npm, ...args] : args, { cwd, encoding: 'utf8', timeout: 180000 });
try {
  const dependencies = {};
  for (const path of ['sendfn/typescript', 'packages/db', 'packages/http', 'packages/delivery', 'packages/observability']) {
    const directory = join(root, path);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json')));
    const [pack] = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], directory));
    dependencies[manifest.name] = 'file:' + join(temporary, pack.filename);
  }
  const overrides = Object.fromEntries(Object.keys(dependencies).map(name => [name, '$' + name]));
  if (process.env.SENDFN_SES_VERSION) overrides['@aws-sdk/client-ses'] = process.env.SENDFN_SES_VERSION;
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies, overrides }));
  runNpm(['install', '--ignore-scripts'], temporary);
  const body = `
    const {createServer}=await import('node:http');
    let count=0,mode='success',sockets=0;
    const server=createServer((request,response)=>{count++;request.resume();if(mode==='drop'){request.socket.destroy();return;}if(mode==='hold'){response.writeHead(200);response.write('<SendEmailResponse>');return;}if(mode==='oversized'){response.writeHead(200);response.write('x'.repeat(1025));return;}response.end('<SendEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendEmailResult><MessageId>installed-id</MessageId></SendEmailResult></SendEmailResponse>');});
    server.on('connection',socket=>{sockets++;socket.once('close',()=>{sockets--;});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const provider=new AwsSesAdapter({region:'us-east-1',accessKeyId:'local',secretAccessKey:'local',endpoint:'http://127.0.0.1:'+server.address().port,timeoutMs:200,maxResponseBytes:1024});
    try {
      const result=await provider.sendEmail({from:'from@example.test',to:['to@example.test'],subject:'local',text:'local'});
      assert.equal(result.success,true);assert.equal(result.providerMessageId,'installed-id');assert.equal(count,1);
      for(const next of ['drop','hold','oversized']){mode=next;const before=count;const failed=await provider.sendEmail({from:'from@example.test',to:['to@example.test'],subject:'local',text:'local'});assert.equal(failed.success,false);assert.equal(count,before+1);}
      await provider.close();
      const closedCount=count;
      for(let attempt=0;attempt<50&&sockets;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(sockets,0);
      assert.equal((await provider.sendEmail({from:'from@example.test',to:['to@example.test'],subject:'closed'})).success,false);assert.equal(count,closedCount);
    } finally {try {await provider.close();} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
  `;
  for (const [extension, imports] of [['mjs', "import assert from 'node:assert/strict';import {AwsSesAdapter} from 'sendfn/adapters/aws-ses';"], ['cjs', "const assert=require('node:assert/strict');const {AwsSesAdapter}=require('sendfn/adapters/aws-ses');"]]) {
    const path = join(temporary, 'consumer.' + extension);
    writeFileSync(path, imports + '\n(async()=>{' + body + '})().catch(error=>{console.error(error);process.exitCode=1;});');
    execFileSync(process.execPath, [path], { cwd: temporary, stdio: 'inherit', timeout: 30000 });
  }
  writeFileSync(join(temporary, 'consumer.ts'), `import {AwsSesAdapter,type AwsSesConfig,type SesSendOptions,type SendEmailRequest} from 'sendfn/adapters/aws-ses';const config:AwsSesConfig={region:'us-east-1',accessKeyId:'local',secretAccessKey:'local',timeoutMs:1000,maxResponseBytes:1024};const request:SendEmailRequest={from:'a@example.test',to:['b@example.test'],subject:'local'};const options:SesSendOptions={signal:new AbortController().signal};async function send(){const provider=new AwsSesAdapter(config);try{return await provider.sendEmail(request,options);}finally{await provider.close();}}void send;`);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--skipLibCheck', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: temporary, stdio: 'inherit', timeout: 30000 });
  console.log('Fresh five-tarball SES typed ESM/CJS consumers passed; SDK ' + (process.env.SENDFN_SES_VERSION ?? 'resolved declared range'));
} finally { rmSync(temporary, { recursive: true, force: true }); }
