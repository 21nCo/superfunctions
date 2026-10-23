import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const temporary=await mkdtemp(join(tmpdir(),'watchfn-auth-consumer-'));
const npm=process.env.WATCHFN_NPM_CLI;
const runNpm=(args,cwd)=>execFileSync(npm?process.execPath:'npm',npm?[npm,...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
try {
 const packages=new Map();
 for(const path of execFileSync('rg',['--files','-g','package.json'],{cwd:root,encoding:'utf8'}).trim().split('\n')) {
  const manifest=JSON.parse(await readFile(join(root,path),'utf8'));
  if(manifest.name)packages.set(manifest.name,{path:resolve(root,path,'..'),manifest});
 }
 const closure=new Map();
 function add(name){if(closure.has(name)||!packages.has(name))return;const item=packages.get(name);closure.set(name,item);for(const dependency of Object.keys(item.manifest.dependencies??{}))add(dependency);}
 add('@watchfn/core');
 const dependencies={};
 for(const [name,item] of closure){const [packed]=JSON.parse(runNpm(['pack','--ignore-scripts','--json','--pack-destination',temporary],item.path));dependencies[name]='file:'+join(temporary,packed.filename);}
 await writeFile(join(temporary,'package.json'),JSON.stringify({private:true,type:'module',dependencies,overrides:Object.fromEntries(Object.keys(dependencies).map(name=>[name,'$'+name]))}));
 runNpm(['install','--ignore-scripts'],temporary);
 const body=`
 const watch=new WatchFn({name:'packed',infra:{enabled:false},auth:{provider:{authenticate:async request=>({id:'key',type:'api-key',subject:{actorId:'browser',actorType:'api-key'},scopes:request.headers.get('authorization')==='Bearer operator'?['watchfn:query']:['watchfn:ingest']})}}});
 watch.start();
 try {
 const request=(path,token,body)=>new Request('http://local'+path,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(body)});
 assert.equal((await watch.httpRouter.handle(request('/ingest','browser',{name:'stored'}))).status,202);
 assert.equal((await watch.httpRouter.handle(request('/query','browser',{}))).status,403);
 const response=await watch.httpRouter.handle(request('/query','operator',{}));assert.equal(response.status,200);assert.equal((await response.json()).results.length,1);
 }finally{await watch.stop();}
 `;
 for(const [extension,imports] of [['mjs',"import assert from 'node:assert/strict';import {WatchFn} from '@watchfn/core';"],['cjs',"const assert=require('node:assert/strict');const {WatchFn}=require('@watchfn/core');"]]){
  const path=join(temporary,'consumer.'+extension);await writeFile(path,imports+'\n(async()=>{'+body+'})().catch(error=>{console.error(error);process.exitCode=1;});');execFileSync(process.execPath,[path],{cwd:temporary,stdio:'inherit'});
 }
 console.log(`Fresh ${closure.size}-tarball ESM/CJS scoped-auth consumers passed`);
}finally{await rm(temporary,{recursive:true,force:true});}
