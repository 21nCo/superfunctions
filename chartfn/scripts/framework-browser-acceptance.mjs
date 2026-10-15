/** Real React/Svelte browser lifecycles from isolated npm tarball consumers. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const evidence = mkdtempSync(join(tmpdir(), 'chartfn-framework-matrix-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const packs = {};
for (const part of ['.', 'react', 'svelte']) {
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', evidence], resolve(root, part)));
  packs[part] = join(evidence, pack.filename);
}
const vendor = `import { chartFn, echartsAdapter } from 'chartfn';
import * as echarts from 'echarts';
export const metrics = { mounts:0, updates:0, disposals:0 };
let element;
const tracked = { name:'tracked', mount(container,spec) {
  metrics.mounts++; element=container;
  const handle=echartsAdapter.mount(container,spec);
  return { update(next){ metrics.updates++;handle.update(next); }, dispose(){metrics.disposals++;handle.dispose();} };
}};
export const api=chartFn({defaultAdapter:'tracked',adapters:{tracked}});
export const initial={type:'bar',data:{series:[{name:'A',values:[2,4,3]}]},passthrough:{echartsOptions:{animation:false}}};
export const current=()=>element && echarts.getInstanceByDom(element)?.getOption();
`;
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><div id="root"></div></body></html>'); });
let browser;
const results = [];
try {
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes)});
  browser = await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH}:{})});
  for (const configuration of [{react:'16.8.6'},{react:'16.14.0'},{react:'18.3.1'},{react:'19'},{svelte:'5'}]) {
    const label=configuration.react?`react-${configuration.react}`:'svelte-5';
    console.log(`Installing isolated ${label} tarball consumer`);
    const directory=join(evidence,label); mkdirSync(directory);
    writeFileSync(join(directory,'package.json'),JSON.stringify({private:true,type:'module'}));
    const packages=configuration.react?[packs['.'],packs.react,`react@${configuration.react}`,`react-dom@${configuration.react}`]:[packs['.'],packs.svelte,`svelte@${configuration.svelte}`];
    run('npm',['install','--ignore-scripts','--no-fund','--no-audit',...packages],directory);
    const consumerRequire=createRequire(join(directory,'package.json'));
    const framework=configuration.react?'react':'svelte';
    const version=consumerRequire(`${framework}/package.json`).version;
    writeFileSync(join(directory,'vendor.js'),vendor);
    let entry; const plugins=[];
    if(configuration.react){
      const modern=Number(version.split('.')[0])>=18;
      entry=`import React from 'react';
${modern?"import { createRoot } from 'react-dom/client';":"import ReactDOM from 'react-dom';"}
import { Chart } from '@chartfn/react';
import { api,initial,metrics,current } from './vendor.js';
const target=document.getElementById('root');
${modern?'const root=createRoot(target);':''}
let spec=initial;let enabled=true;
const render=()=>${modern?'root.render':'ReactDOM.render'}(React.createElement(React.StrictMode,null,React.createElement(Chart,{spec,api:enabled?api:undefined,style:{width:600,height:400}}))${modern?'':',target'});
window.harness={metrics,current,mount:render,update(next){spec=next;render();},enable(value){enabled=value;render();},unmount(){${modern?'root.unmount()':'ReactDOM.unmountComponentAtNode(target)'}}};`;
    }else{
      writeFileSync(join(directory,'App.svelte'),`<script>
import { Chart } from '@chartfn/svelte';
import { api,initial } from './vendor.js';
let spec=initial; let enabled=true;
export function update(next){spec=next;}
export function enable(value){enabled=value;}
</script>
<Chart {spec} api={enabled?api:undefined} style="width:600px;height:400px" />`);
      const {compile}=consumerRequire('svelte/compiler');
      plugins.push({name:'consumer-svelte',setup(build){build.onLoad({filter:/\.svelte$/},async args=>({contents:compile(readFileSync(args.path,'utf8'),{filename:args.path,generate:'client',dev:true}).js.code,loader:'js',resolveDir:dirname(args.path)}))}});
      entry=`import {mount,unmount} from 'svelte';import App from './App.svelte';import {metrics,current} from './vendor.js';let app;window.harness={metrics,current,mount(){app=mount(App,{target:document.getElementById('root')});},update(next){app.update(next);},enable(value){app.enable(value);},unmount(){return unmount(app);}};`;
    }
    const bundle=await build({stdin:{contents:entry,resolveDir:directory,sourcefile:'consumer.js'},absWorkingDir:directory,bundle:true,write:false,format:'iife',platform:'browser',conditions:['browser','svelte'],plugins});
    const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    await page.evaluate(()=>window.harness.mount());
    await page.waitForFunction(()=>window.harness.current()?.series[0].data[0]===2);
    const initialMounts=await page.evaluate(()=>window.harness.metrics.mounts);
    await page.evaluate(()=>window.harness.update({type:'line',data:{series:[{name:'A',values:[9,7,5]}]},passthrough:{echartsOptions:{animation:false}}}));
    await page.waitForFunction(()=>window.harness.current()?.series[0].type==='line'&&window.harness.current().series[0].data[0]===9);
    if(await page.evaluate(()=>window.harness.metrics.mounts)!==initialMounts)throw Error(`${label}: spec update remounted binding`);
    await page.evaluate(()=>window.harness.enable(false));
    await page.waitForFunction(()=>document.querySelectorAll('canvas').length===0);
    await page.evaluate(()=>window.harness.enable(true));
    await page.waitForFunction(()=>window.harness.current()?.series[0].data[0]===9&&document.querySelectorAll('canvas').length>0);
    await page.evaluate(()=>window.harness.unmount());
    await page.waitForFunction(()=>document.querySelectorAll('canvas').length===0);
    const metrics=await page.evaluate(()=>window.harness.metrics);
    if(metrics.mounts!==metrics.disposals||metrics.updates<1)throw Error(`${label}: unbalanced lifecycle ${JSON.stringify(metrics)}`);
    if(errors.length)throw Error(`${label}: ${errors.join(';')}`);
    const result={framework,version,metrics,pageErrors:errors,consumer:directory};results.push(result);console.log(JSON.stringify(result));
    await page.close();
  }
  const report={browser:await browser.version(),results};writeFileSync(join(evidence,'results.json'),JSON.stringify(report,null,2));console.log(`Framework matrix passed; evidence retained at ${evidence}`);
}catch(error){if(error.stdout)process.stderr.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);throw error;}finally{try{await browser?.close()}finally{if(server.listening)await new Promise(resolve=>server.close(resolve))}}
