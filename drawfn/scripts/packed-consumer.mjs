/** Validate actual tarballs without workspace resolution or runtime audit noise from tools. */
import {npmCli} from './npm-cli.mjs';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url)),directory=mkdtempSync(join(tmpdir(),'drawfn-packed-consumer-'));
const run=(command,args,cwd=directory)=>execFileSync(command,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const packs=[];
for(const name of ['core','drawfn-react','drawfn-svelte']){const[p]=JSON.parse(run(process.execPath,[npmCli,'pack','--json','--ignore-scripts','--pack-destination',directory],resolve(root,name)));packs.push(join(directory,p.filename))}
writeFileSync(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
try{
 run(process.execPath,[npmCli,'install','--ignore-scripts','--no-fund','--no-audit',...packs,'react@18.3.1','react-dom@18.3.1','svelte@5']);
 run(process.execPath,[npmCli,'install','--save-dev','--ignore-scripts','--no-fund','--no-audit','typescript@5.9.3','@types/react@18','@types/react-dom@18','esbuild']);
 const req=createRequire(join(directory,'package.json'));
 const fixture=`import {Drawfn, type DrawfnOptions, type Scene} from 'drawfn';
import {DrawfnCanvas, useDrawfn, type UseDrawfnOptions} from '@drawfn/react';
import {drawfn,createDrawfnStore,type DrawfnActionOptions} from '@drawfn/svelte';
const options: DrawfnOptions={canvas:document.createElement('canvas'),getNodePreview:async()=>({title:'ok'})};
const core=new Drawfn(options);core.resetHistory();const scene:Scene=core.getScene();
function resetReact(api:ReturnType<typeof useDrawfn>){api.resetHistory()}
const reactOptions:UseDrawfnOptions={scene};const actionOptions:DrawfnActionOptions={scene};
void [DrawfnCanvas,useDrawfn,reactOptions,drawfn,createDrawfnStore,actionOptions];`;
 writeFileSync(join(directory,'consumer.mts'),fixture+`\ncreateDrawfnStore().resetHistory();\nimport Canvas from '@drawfn/svelte/Canvas.svelte';import Drawing from '@drawfn/svelte/DrawfnCanvas.svelte';void [Canvas,Drawing];`);
 writeFileSync(join(directory,'consumer.cts'),fixture.replace("import {drawfn,createDrawfnStore,type DrawfnActionOptions} from '@drawfn/svelte';","type DrawfnActionOptions = import('@drawfn/svelte', { with: { 'resolution-mode': 'import' } }).DrawfnActionOptions; const {drawfn,createDrawfnStore} = await import('@drawfn/svelte');").replace("const {drawfn,createDrawfnStore} = await import('@drawfn/svelte');","const actionImport = import('@drawfn/svelte');").replace('void [DrawfnCanvas,useDrawfn,reactOptions,drawfn,createDrawfnStore,actionOptions];','void [DrawfnCanvas,useDrawfn,reactOptions,actionImport,actionOptions];'));
 for(const mode of ['Node16','NodeNext']){run(process.execPath,[req.resolve('typescript/bin/tsc'),'--noEmit','--strict','--target','ES2021','--module',mode,'--moduleResolution',mode,'--lib','ES2021,DOM','consumer.mts','consumer.cts']);console.log(`${mode} .mts/.cts and component declarations passed`)}
 const esm=`import assert from 'node:assert/strict';import {Drawfn} from 'drawfn';import {DrawfnCanvas} from '@drawfn/react';import {drawfn,createDrawfnStore} from '@drawfn/svelte';import React from 'react';import {renderToString} from 'react-dom/server';assert.equal(typeof Drawfn,'function');assert.equal(typeof drawfn,'function');assert.equal(typeof createDrawfnStore,'function');assert.match(renderToString(React.createElement(DrawfnCanvas,{width:321,height:123})),/<canvas[^>]*width="321"/);console.log('ESM imports and React SSR passed',process.version);`;
 const cjs=`const assert=require('node:assert/strict');const {Drawfn}=require('drawfn');const {DrawfnCanvas}=require('@drawfn/react');const React=require('react');const {renderToString}=require('react-dom/server');assert.throws(()=>require('@drawfn/svelte'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});assert.equal(typeof Drawfn,'function');assert.match(renderToString(React.createElement(DrawfnCanvas)),/<canvas/);import('@drawfn/svelte').then(({drawfn,createDrawfnStore})=>{assert.equal(typeof drawfn,'function');assert.equal(typeof createDrawfnStore,'function');console.log('CJS core/react and dynamic Svelte import passed',process.version)});`;
 writeFileSync(join(directory,'smoke.mjs'),esm);writeFileSync(join(directory,'smoke.cjs'),cjs);
 // Compile the published Svelte component with the consumer's compiler for real SSR.
 const {compile}=req('svelte/compiler'),{build}=req('esbuild');
 await build({stdin:{contents:`import {render} from 'svelte/server';import Drawing from '@drawfn/svelte/DrawfnCanvas.svelte';import assert from 'node:assert/strict';assert.match(render(Drawing,{props:{width:321,height:123}}).body,/<canvas[^>]*width="321"/);console.log('Svelte component SSR passed',process.version);`,resolveDir:directory},absWorkingDir:directory,bundle:true,platform:'node',format:'esm',outfile:join(directory,'svelte-ssr.mjs'),plugins:[{name:'svelte-ssr',setup(build){build.onLoad({filter:/\.svelte$/},args=>({contents:compile(readFileSync(args.path,'utf8'),{filename:args.path,generate:'server'}).js.code,loader:'js',resolveDir:dirname(args.path)}))}}]});
 const runtimes=[];
 for(const version of ['18.18.0','20','22']){for(const file of ['smoke.mjs','smoke.cjs','svelte-ssr.mjs']){const output=run(process.execPath,[npmCli,'exec','--yes',`--package=node@${version}`,'--','node',join(directory,file)]);process.stdout.write(output);runtimes.push({requested:version,file,output:output.trim()})}}
 const result=spawnSync(process.execPath,[npmCli,'audit','--omit=dev','--json'],{cwd:directory,encoding:'utf8'});writeFileSync(join(directory,'audit.json'),result.stdout);const audit=JSON.parse(result.stdout);console.log(JSON.stringify(audit.metadata));
 writeFileSync(join(directory,'results.json'),JSON.stringify({runtimes,audit:audit.metadata},null,2));console.log(`Packed consumer evidence: ${directory}`);if(result.status!==0)throw Error('Runtime audit found vulnerabilities; inspect retained audit.json');
}catch(error){console.error(`Retained consumer: ${directory}`);if(error.stdout)process.stderr.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);throw error}
