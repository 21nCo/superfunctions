/** Actual same-browser final-state determinism, with vendor animations disabled. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(resolve(root,'package.json'));
const {build}=require('esbuild');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const bundle=await build({stdin:{contents:`export {chartFn} from './src/chart-fn.ts';export {chartjsAdapter} from './src/adapters/chartjs.ts';export {echartsAdapter} from './src/adapters/echarts.ts';export {carbonAdapter} from './src/adapters/carbon.ts';`,resolveDir:root},bundle:true,format:'iife',globalName:'Charts',platform:'browser',write:false});
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body></body></html>')});
let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1400,height:900},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.addStyleTag({content:readFileSync(require.resolve('@carbon/charts/styles.css'),'utf8')});
  const cases=await page.evaluate(async()=>{
    const {chartFn,chartjsAdapter,echartsAdapter,carbonAdapter}=Charts;
    const checks=[];
    const pixels=async uri=>{
      const image=new Image();image.src=uri;await image.decode();
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      return {width:image.width,height:image.height,data:context.getImageData(0,0,image.width,image.height).data};
    };
    for(const [name,adapter] of [['echarts',echartsAdapter],['chartjs',chartjsAdapter],['carbon',carbonAdapter]]){
      const api=chartFn({defaultAdapter:name,adapters:{[name]:adapter}});
      for(const type of ['bar','line','area','pie','donut','scatter','combo']){
        const spec={type,data:{dimensions:['A','B','C'],series:[{name:'One',values:[2,4,3]},{name:'Two',values:[3,2,5]}]},passthrough:{echartsOptions:{animation:false},chartjsOptions:{animation:false},carbonOptions:{animations:false}}};
        const containers=[],handles=[];
        try{
          for(let index=0;index<2;index++){
            const container=document.createElement('div');container.style.cssText='width:600px;height:400px';document.body.appendChild(container);containers.push(container);
            const mounted=api.render(container,spec);if(!mounted.ok)throw Error(JSON.stringify(mounted.error));handles.push(mounted.result);
          }
          await new Promise(resolve=>setTimeout(resolve,150));
          const images=[];
          for(let index=0;index<2;index++)images.push(await pixels(name==='chartjs'?containers[index].querySelector('canvas').toDataURL('image/png'):await handles[index].toImage({format:'png',width:600,height:400})));
          const [first,second]=images;
          if(first.width!==second.width||first.height!==second.height||first.data.length!==second.data.length)throw Error(`${name}/${type}: dimensions differ`);
          let changed=0;for(let index=0;index<first.data.length;index++)if(first.data[index]!==second.data[index])changed++;
          if(changed)throw Error(`${name}/${type}: ${changed} RGBA channels differ`);
          if(!first.data.some((value,index)=>index%4===3&&value>0))throw Error(`${name}/${type}: blank image`);
          checks.push({adapter:name,type,width:first.width,height:first.height,differentChannels:changed});
        }finally{handles.forEach(handle=>handle.dispose());containers.forEach(container=>container.remove())}
      }
    }
    return checks;
  });
  if(errors.length)throw Error(errors.join('\n'));
  console.log(JSON.stringify({browser:await browser.version(),cases,pageErrors:errors},null,2));
}finally{try{await browser?.close()}finally{if(server.listening)await new Promise(resolve=>server.close(resolve))}}
