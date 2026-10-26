import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const temporary=mkdtempSync(join(tmpdir(),'browse-batches-packed-'));
const npmCommand=process.env.NPM_CLI ? process.execPath : 'npm';
const npmArgs=args=>process.env.NPM_CLI ? [process.env.NPM_CLI,...args] : args;
const run=(command,args,cwd)=>execFileSync(command==='npm'?npmCommand:command,command==='npm'?npmArgs(args):args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
try {
 const packs=join(temporary,'packs');mkdirSync(packs);
 const tarballs=['packages/observability','packages/http','packages/middleware','packages/db','packages/storage','packages/storage-local','browsefn/typescript'].map(path=>join(packs,JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',packs],join(root,path)))[0].filename));
 writeFileSync(join(temporary,'package.json'),JSON.stringify({private:true,type:'module'}));
 run('npm',['install','--omit=dev','--no-audit','--no-fund',...tarballs],temporary);
 writeFileSync(join(temporary,'batch.mjs'),`
import assert from 'node:assert/strict';import {createServer} from 'node:http';import {readFile,readdir,mkdir} from 'node:fs/promises';import {browseFn,createBrowseFnRouter} from 'browsefn';import sharp from 'sharp';
const png=await sharp({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer();let hits=0;
const server=createServer((req,res)=>{hits++;res.end(req.url.startsWith('/image')?png:'<title>packed</title>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
 const base='http://127.0.0.1:'+server.address().port;const browser=browseFn();
 const pages=Array.from({length:100},(_,i)=>base+'/page/'+i);const progress=[];
 const metadata=await browser.web.getMultipleMetadata(pages,{concurrency:5,onProgress:(done,total)=>{progress.push([done,total]);if(done===1) pages.push(base+'/late');}});
 assert.equal(metadata.length,100);assert.ok(metadata.every(item=>item.success && item.data.title==='packed'));assert.deepEqual(progress.at(-1),[100,100]);assert.equal(hits,100);
 await assert.rejects(browser.web.getMultipleMetadata(pages,{maxBatchOverride:1000}),{code:'INVALID_ARGUMENT'});assert.equal(hits,100);
 const destination=new URL('./images/',import.meta.url).pathname;await mkdir(destination);
 const images=Array.from({length:50},(_,i)=>base+'/image-'+i+'.png');const results=await browser.images.downloadBatch(images,{destination,allowPrivateHosts:true,concurrency:3,onProgress:(done,total)=>{assert.equal(total,50);if(done===1)images.push(base+'/late.png');}});
 assert.equal(results.length,50);assert.ok(results.every(item=>item.success));assert.equal((await readdir(destination)).length,50);assert.deepEqual(await readFile(results[0].path),png);assert.equal(hits,150);
 await assert.rejects(browser.images.downloadBatch(images,{destination,allowPrivateHosts:true}),{code:'INVALID_ARGUMENT'});assert.equal(hits,150);
 const router=createBrowseFnRouter(browser);const denied=await router.handle(new Request('http://local/web/metadata',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({urls:pages,options:{maxBatchOverride:1000}})}));assert.equal(denied.status,400);assert.equal(hits,150);
 console.log(JSON.stringify({metadata:100,images:50,httpRequests:hits,mutationBounded:true,routerCeiling:true,node:process.version}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve()));}
`);
 console.log(run(process.execPath,['batch.mjs'],temporary).trim());
 const audit=spawnSync(npmCommand,npmArgs(['audit','--omit=dev','--json']),{cwd:temporary,encoding:'utf8'});const report=JSON.parse(audit.stdout);console.log(JSON.stringify({productionAudit:report.metadata?.vulnerabilities}));assert.equal(report.metadata?.vulnerabilities.total,0,'Production audit remains a gate');
} finally {rmSync(temporary,{recursive:true,force:true});console.log('Owned consumer, tarballs and files removed');}
