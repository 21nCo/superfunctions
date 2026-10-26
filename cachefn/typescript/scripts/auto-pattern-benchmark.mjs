/** Original 30 x 1000 pattern workload, explicit IndexedDB control versus public auto. */
import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';import {createServer} from 'node:http';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {dirname, resolve, relative} from 'node:path'; import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require=createRequire(root+'/package.json');const {build}=require('esbuild');const playwright=require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const original=readFileSync(root+'/cachefn/typescript/scripts/benchmark.mjs','utf8');
const start=original.indexOf('        const invalidations = [];',original.indexOf("if (storage === 'indexeddb')"));const end=original.indexOf('\n      }',start);const workload=original.slice(start,end).replace('output.indexeddb_pattern_invalidation_1000','output[storage]');
if(!workload.includes('trial < 30')||!workload.includes('i < 1000'))throw Error('Workload extraction failed');
const requestedRef=process.argv.find(value=>value.startsWith('--ref='))?.slice(6);
const sourceRef=requestedRef ? execFileSync('git',['rev-parse','--verify','--end-of-options',`${requestedRef}^{commit}`],{cwd:root,encoding:'utf8'}).trim() : undefined;
const plugins=sourceRef ? [{name:'source-snapshot',setup(builder){builder.onLoad({filter:/\.ts$/},args=>{
  const directory=resolve(root,'cachefn/typescript/src');
  if(!args.path.startsWith(directory+'/'))return;
  return {contents:execFileSync('git',['show',`${sourceRef}:cachefn/typescript/src/${relative(directory,args.path)}`],{cwd:root,encoding:'utf8'}),loader:'ts',resolveDir:dirname(args.path)};
});}}] : [];
const bundle=await build({plugins,stdin:{contents:'export {CacheFn} from "./src/index.ts"',resolveDir:root+'/cachefn/typescript'},bundle:true,platform:'browser',format:'iife',globalName:'Benchmark',write:false});
const server=createServer((_req,res)=>{res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.end('<title>Owned Cache performance</title>');});let browser;let deadline;
try{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await playwright.chromium.launch({headless:true});deadline=setTimeout(()=>void browser.close(),180000);const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);await page.addScriptTag({content:bundle.outputFiles[0].text});
const evaluate=`async()=>{const {CacheFn}=Benchmark;const output={};const assert=(condition,message)=>{if(!condition)throw Error(message)};const summarize=(samples,target)=>{const raw=[...samples];samples.sort((a,b)=>a-b);const at=p=>samples[Math.min(samples.length-1,Math.ceil(samples.length*p)-1)];return {samples:samples.length,raw_ms:raw,p50_ms:at(.5),p95_ms:at(.95),p99_ms:at(.99),target_ms:target,pass:at(.99)<target}};for(const storage of ['indexeddb','auto']){const cache=new CacheFn({name:'owned-auto-benchmark-'+storage+'-'+crypto.randomUUID(),storage,maxSize:10000});for(let i=0;i<100;i++)await cache.set('warm:'+i,i);await cache.clear();${workload};cache.dispose();}return output;}`;
const results=await page.evaluate('('+evaluate+')()');console.log(JSON.stringify({source:sourceRef || execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),originalHarnessSha256:createHash('sha256').update(original).digest('hex'),workloadSha256:createHash('sha256').update(workload).digest('hex'),bundleSha256:createHash('sha256').update(bundle.outputFiles[0].text).digest('hex'),browser:await browser.version(),results},null,2));
}finally{clearTimeout(deadline);await browser?.close();if(server.listening)await new Promise(resolve=>server.close(resolve));}
