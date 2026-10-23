/** Build packages first. Normal isolated tarballs plus an externally installed Python wheel. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(join(tmpdir(), 'userfn-survey-package-'));
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const npm = (args, cwd) => process.env.USERFN_NPM_CLI ? run(process.execPath, [process.env.USERFN_NPM_CLI, ...args], cwd) : run('npm', args, cwd);
if (!process.env.USERFN_SURVEY_WHEEL_PYTHON) throw new Error('USERFN_SURVEY_WHEEL_PYTHON must identify a separately installed wheel environment');
try {
  const tarballs = [];
  for (const folder of ['packages/observability', 'packages/auth', 'packages/http', 'packages/db', 'watchfn/agents/browser', 'userfn/typescript', 'userfn/service']) {
    const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', directory], join(root, folder))); tarballs.push(join(directory, pack.filename));
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--no-fund', ...tarballs, 'typescript@5.6.3', '@types/node@22']);
  let audit; try { audit = npm(['audit', '--omit=dev', '--json']); } catch (error) { audit = String(error.stdout); }
  await writeFile('/tmp/user-survey-packed-audit.json', audit);
  const fixture = `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createUserFnService } from '@userfn/service';
import { UserFnClient } from 'userfn';
const db=memoryAdapter();
const service=createUserFnService({database:db,auth:{async authenticate(request){const actorId=request.headers.get('authorization').slice(7);return {id:actorId,type:'session',subject:{actorId,actorType:'user',tenantId:'tenant'},scopes:['userfn:surveys:write']}}},surveys:{resolvePolicy:()=>({enabled:true,perUser:2,window:{limit:2,durationMs:60000},questions:[{id:'score',type:'nps',title:'Score',required:true}]})}});
const lost=new Set(['esm','cjs','python']);
const server=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const response=await service.router.handle(new Request('http://local'+req.url,{method:req.method,headers:req.headers,body:Buffer.concat(chunks)}));if(lost.delete(req.headers['idempotency-key'])){res.destroy();return}res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const endpoint='http://127.0.0.1:'+server.address().port;
try{
 const {UserFnClient:Cjs}=createRequire(import.meta.url)('userfn');
 for(const [Client,key] of [[UserFnClient,'esm'],[Cjs,'cjs']]){
  const client=new Client({apiKey:key,endpoint});const answers=[{questionId:'score',value:8}];
  const first=await client.submitSurveyResponse('survey',answers,{idempotencyKey:key});assert.equal(first.accepted,true);
  assert.deepEqual(await client.submitSurveyResponse('survey',answers,{idempotencyKey:key}),first);
  await client.submitSurveyResponse('survey',answers,{idempotencyKey:key+'-next'});
  await assert.rejects(client.submitSurveyResponse('survey',answers,{idempotencyKey:key+'-capped'}),e=>e.status===429);
 }
 const code=\`import asyncio,sys,userfn
from userfn import UserFnClient,UserFnOptions,SurveyResponseAnswer,SurveyDeliveryError
assert 'site-packages' in userfn.__file__,userfn.__file__
async def run():
 c=UserFnClient(UserFnOptions(api_key='python',endpoint=sys.argv[1]))
 a=[SurveyResponseAnswer(question_id='score',value=8)]
 first=await c.submit_survey_response('survey',a,idempotency_key='python')
 assert first.accepted
 assert await c.submit_survey_response('survey',a,idempotency_key='python')==first
 await c.submit_survey_response('survey',a,idempotency_key='python-next')
 try:
  await c.submit_survey_response('survey',a,idempotency_key='python-capped')
  raise AssertionError('cap not enforced')
 except SurveyDeliveryError as error: assert error.status==429
asyncio.run(run())\`;
 await promisify(execFile)(process.env.USERFN_SURVEY_WHEEL_PYTHON,['-I','-c',code,endpoint]);
 assert.equal(lost.size,0);console.log('Installed ESM/CJS/Python wheel survey HTTP lost-ACK replay and caps passed');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close()}
`;
  await writeFile(join(directory, 'runtime.mjs'), fixture);
  process.stdout.write(run(process.execPath, ['runtime.mjs']));
  for (const extension of ['mts', 'cts']) {
    await writeFile(join(directory, `consumer.${extension}`), `import {UserFnClient,type SurveyReceipt} from 'userfn'; const receipt:Promise<SurveyReceipt>=new UserFnClient({apiKey:'key',endpoint:'https://example.test'}).submitSurveyResponse('s',[{questionId:'q',value:8}],{idempotencyKey:'key'}); void receipt;`);
    process.stdout.write(run(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', `consumer.${extension}`]));
  }
  console.log(JSON.stringify({ passed: true, installedPackages: tarballs.length, productionAudit: JSON.parse(audit).metadata?.vulnerabilities }));
} finally { await rm(directory, { recursive: true, force: true }); }
