/** Packed, isolated React 18/19 and Svelte 5 browser consumers. Build packages first. */
import {npmCli} from './npm-cli.mjs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(join(root,'core/package.json'));
const {build}=require('esbuild');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const evidence=mkdtempSync(join(tmpdir(),'drawfn-framework-matrix-'));
const run=(args,cwd)=>execFileSync(process.execPath,[npmCli,...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const packs={};
for(const part of ['core','drawfn-react','drawfn-svelte']){const[p]=JSON.parse(run(['pack','--json','--ignore-scripts','--pack-destination',evidence],resolve(root,part)));packs[part]=join(evidence,p.filename)}
const server=createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><style>body{margin:0}</style><div id="root"></div>')});
let browser;const results=[];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH}:{})});
 for(const [framework,requested] of [['react','18.3.1'],['react','19'],['svelte','5.57.2']]){
  const label=`${framework}-${requested}`, directory=join(evidence,label);mkdirSync(directory);writeFileSync(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
  console.log(`Installing ${label} packed consumer`);
  run(['install','--ignore-scripts','--no-fund','--no-audit',packs.core,packs[`drawfn-${framework}`],`${framework}@${requested}`,...(framework==='react'?[`react-dom@${requested}`]:[])],directory);
  const consumerRequire=createRequire(join(directory,'package.json')),version=consumerRequire(`${framework}/package.json`).version;
  const state=`export const state={current:null,ready:0,changes:0,clicks:[],instances:[]};export const ready=value=>{const api=value.drawfn??value;state.current=api;state.instances.push(api);state.ready++};export const changed=()=>state.changes++;export const clicked=id=>state.clicks.push(id);export const preview=async()=>({title:'Preview from binding'});`;
  writeFileSync(join(directory,'state.js'),state);
  let entry;const plugins=[];
  if(framework==='react'){
   entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {DrawfnCanvas} from '@drawfn/react';import {state,ready,changed,clicked,preview} from './state.js';const root=createRoot(document.getElementById('root'));let width=640,height=480,overlayRoot,scene;const render=()=>root.render(React.createElement(React.StrictMode,null,React.createElement(DrawfnCanvas,{width,height,overlayRoot,scene,onReady:ready,onSceneChange:changed,onNodeClick:clicked,getNodePreview:preview})));window.harness={state,mount:render,resize(){width=800;height=500;render()},replace(){overlayRoot=document.createElement('div');document.body.append(overlayRoot);render()},load(value){scene=value;render()},unmount(){root.unmount()}};`;
  }else{
   writeFileSync(join(directory,'App.svelte'),`<script>import DrawfnCanvas from '@drawfn/svelte/DrawfnCanvas.svelte';import {ready,changed,clicked,preview} from './state.js';let width=640,height=480,overlayRoot,scene;export function resize(){width=800;height=500}export function replace(){overlayRoot=document.createElement('div');document.body.append(overlayRoot)}export function load(value){scene=value}</script><DrawfnCanvas {width} {height} {overlayRoot} {scene} onReady={ready} onSceneChange={changed} onNodeClick={clicked} getNodePreview={preview}/>`);
   const{compile}=consumerRequire('svelte/compiler');const modern=Number(version.split('.')[0])>=5;
   plugins.push({name:'svelte-consumer',setup(build){build.onLoad({filter:/\.svelte$/},async args=>({contents:compile(readFileSync(args.path,'utf8'),{filename:args.path,generate:modern?'client':'dom',dev:true}).js.code,loader:'js',resolveDir:dirname(args.path)}))}});
   entry=`${modern?"import {mount,unmount} from 'svelte';":''}import App from './App.svelte';import {state} from './state.js';let app;window.harness={state,mount(){app=${modern?"mount(App,{target:document.getElementById('root')})":"new App({target:document.getElementById('root')})"}},resize(){app.resize()},replace(){app.replace()},load(scene){app.load(scene)},unmount(){${modern?'return unmount(app)':'app.$destroy()'}}};`;
  }
  const bundle=await build({stdin:{contents:entry,resolveDir:directory},absWorkingDir:directory,bundle:true,write:false,format:'iife',platform:'browser',conditions:['browser','svelte'],plugins});
  const page=await browser.newPage({viewport:{width:1000,height:700}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let assertions=0;const check=(value,msg)=>{if(!value)throw Error(`${label}: ${msg}`);assertions++};
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addScriptTag({content:bundle.outputFiles[0].text});await page.evaluate(()=>harness.mount());await page.waitForFunction(()=>harness.state.current);
  await page.evaluate(()=>harness.state.current.setTool('rectangle'));await page.mouse.move(40,40);await page.mouse.down();await page.mouse.move(140,100,{steps:5});await page.mouse.up();
  check(await page.evaluate(()=>harness.state.current.getElements().length===1),'real pointer drawing');check(await page.evaluate(()=>harness.state.changes>0),'scene change callback');
  await page.evaluate(()=>{const a=harness.state.current;window.oldApi=a;const r=a.getElements()[0];a.update(r.id,{fill:'#ff0000',strokeWidth:0})});
  await page.waitForFunction(()=>document.querySelector('canvas').getContext('2d').getImageData(60,60,1,1).data[0]===255&&document.querySelector('canvas').getContext('2d').getImageData(60,60,1,1).data[1]===0);
  await page.evaluate(()=>harness.resize());await page.waitForFunction(()=>document.querySelector('canvas').width===800);
  await page.waitForFunction(()=>{const p=document.querySelector('canvas').getContext('2d').getImageData(60,60,1,1).data;return p[0]===255&&p[1]===0&&p[3]===255},{},{timeout:3000});assertions++;
  await page.evaluate(()=>harness.replace());await page.waitForFunction(()=>harness.state.current!==window.oldApi);
  check(await page.evaluate(()=>harness.state.current.getElements().length===1),'scene retained across construction option change');
  const readyCount=await page.evaluate(()=>harness.state.ready);check(readyCount>=2,'replacement invokes onReady');
  await page.evaluate(()=>{const a=harness.state.current;const scene=a.getScene();scene.elements=[{...scene.elements[0],id:'node',type:'node',nodeId:'n',variant:'card',x:20,y:20,w:120,h:80}];harness.load(scene)});
  await page.waitForFunction(()=>harness.state.current.getElements()[0]?.preview?.title==='Preview from binding');assertions++;
  await page.evaluate(()=>harness.state.current.setTool('select'));await page.mouse.click(60,60);check(await page.evaluate(()=>harness.state.clicks.join(',')==='n'),'node click callback');
  check(await page.evaluate(()=>harness.state.current.getElements().length===1&&harness.state.current.getElements()[0].id==='node'),'controlled scene update');
  const exportSize=await page.evaluate(async()=>{const image=await createImageBitmap(await harness.state.current.exportPNG({fitContent:true,scale:1,padding:0}));const result=[image.width,image.height];image.close();return result});check(exportSize[0]===120&&exportSize[1]===80,'PNG export through binding instance');
  check(await page.evaluate(()=>{const api=harness.state.current;const prior=JSON.stringify(api.getScene());api.clear();api.undo();return JSON.stringify(api.getScene())===prior}),'packed clear is undoable');
  check(await page.evaluate(()=>{const api=harness.state.current;const prior=JSON.stringify(api.getScene());api.resetHistory();return !api.getHistoryState().canUndo&&JSON.stringify(api.getScene())===prior}),'packed resetHistory preserves content');
  await page.evaluate(()=>harness.unmount());check(await page.locator('canvas').count()===0,'unmount removes canvas');
  check(await page.evaluate(()=>harness.state.instances.every(api=>api.destroyed===true)),'all replaced/unmounted core instances disposed');check(errors.length===0,`browser errors ${errors.join(';')}`);
  const result={framework,version,assertions,readyCount,pageErrors:errors,consumer:directory};results.push(result);writeFileSync(join(evidence,'results.json'),JSON.stringify({browser:await browser.version(),results},null,2));console.log(JSON.stringify(result));await page.close();
 }
 writeFileSync(join(evidence,'results.json'),JSON.stringify({browser:await browser.version(),results},null,2));console.log(`Framework matrix passed; evidence ${evidence}`);
}catch(e){if(e.stdout)process.stderr.write(e.stdout);if(e.stderr)process.stderr.write(e.stderr);throw e}finally{try{await browser?.close()}finally{await new Promise(r=>server.close(r))}}
