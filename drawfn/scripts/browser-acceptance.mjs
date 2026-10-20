/** Real canvas interactions and export pixels; run from any directory. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const root=fileURLToPath(new URL('../core/',import.meta.url));
const require=createRequire(root+'package.json');
const {build}=require('esbuild');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
const bundle=await build({stdin:{contents:`import {Drawfn} from './src/index.ts';window.Drawfn=Drawfn;`,resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife'});
const server=createServer((req,res)=>{const files={'/drawfn/core/example.html':root+'example.html','/drawfn/core/dist/index.js':root+'dist/index.js','/node_modules/perfect-freehand/dist/esm/index.mjs':resolve(dirname(require.resolve('perfect-freehand')),'../esm/index.mjs')};const file=files[req.url];if(file){res.setHeader('Content-Type',file.endsWith('.html')?'text/html':'text/javascript');res.end(readFileSync(file));return}res.setHeader('Content-Type','text/html');res.end('<!doctype html><style>body{margin:0}canvas{display:block}</style><canvas id="a" width="640" height="480"></canvas><canvas id="b" width="640" height="480"></canvas><input id="input">')});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const imageServer=createServer((req,res)=>{res.setHeader('Content-Type','image/png');res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64'))});
await new Promise(resolve=>imageServer.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE_PATH?{executablePath:process.env.BROWSER_EXECUTABLE_PATH}:{})});
let assertions=0;const check=(value,message)=>{if(!value)throw Error(message);assertions++};
try{
 const page=await browser.newPage({viewport:{width:1000,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(()=>{window.nodeClicks=[];window.a=new Drawfn({canvas:document.querySelector('#a'),onNodeClick:(id)=>window.nodeClicks.push(id),getNodePreview:async()=>({title:'Resolved node',description:'Details'})});window.b=new Drawfn({canvas:document.querySelector('#b')});window.rect={id:'r',type:'rectangle',x:1000,y:2000,w:100,h:60,rotation:0,stroke:'#000000',fill:'#ff0000',strokeWidth:0,opacity:1};});
 const drag=async(x,y,tx,ty)=>{await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(tx,ty,{steps:8});await page.mouse.up();};
 for(const tool of ['rectangle','ellipse','arrow','pen']){
  await page.evaluate(tool=>{a.clear();a.setTool(tool)},tool);await drag(60,70,180,140);
  const result=await page.evaluate(()=>({elements:a.getElements(),scene:a.getScene()}));
  check(result.elements.length===1,`${tool} creates one element`);check(result.elements[0].w>0&&result.elements[0].h>0,`${tool} has dimensions`);
  await page.evaluate(()=>a.undo());check(await page.evaluate(()=>a.getElements().length===0),`${tool} undo`);
  await page.evaluate(()=>a.redo());check(await page.evaluate(()=>a.getElements().length===1),`${tool} redo`);
 }
 // Browser pointer cancellation restores the gesture snapshot without history.
 await page.evaluate(()=>{a.clear();a.resetHistory();a.setTool('rectangle');a.on('pointerDown',e=>window.activePointer=e.pointerId)});
 await page.mouse.move(30,30);await page.mouse.down();await page.mouse.move(90,80,{steps:4});
 await page.evaluate(()=>document.querySelector('#a').dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.activePointer,bubbles:true})));await page.mouse.up();
 check(await page.evaluate(()=>a.getElements().length===0&&!a.getHistoryState().canUndo),'canceled shape rolls back without undo entry');
 await page.evaluate(()=>a.setTool('pen'));await page.mouse.click(50,50);await page.waitForTimeout(30);
 check(await page.evaluate(()=>a.getElements()[0]?.points?.length===1&&document.querySelector('#a').getContext('2d').getImageData(50,50,1,1).data[0]<50),'pen tap renders a dot');
 // Selection movement and handles use actual pointer positions.
 await page.evaluate(()=>{a.clear();a.add({...rect,x:60,y:70,w:120,h:70});a.setTool('select')});
 await drag(100,100,140,130);check(await page.evaluate(()=>a.getElementById('r').x===100&&a.getElementById('r').y===100),'selection moves');
 await drag(220,170,260,210);check(await page.evaluate(()=>a.getElementById('r').w>120&&a.getElementById('r').h>70),'selection resize');
 const rotate=await page.evaluate(()=>{const r=a.getElementById('r');return{x:r.x+r.w/2,y:r.y-20}});
 await drag(rotate.x,rotate.y,rotate.x+50,rotate.y+40);check(await page.evaluate(()=>Math.abs(a.getElementById('r').rotation)>0.1),'selection rotation');
 // Text receives keyboard input immediately after the pointer gesture.
 await page.evaluate(()=>{a.clear();a.setTool('text');window.textReasons=[];a.on('sceneChanged',event=>window.textReasons.push(event.reason))});await page.mouse.click(80,80);check(await page.evaluate(()=>document.activeElement?.tagName==='TEXTAREA'),'text editor receives focus');
 await page.keyboard.type('Canvas text');await page.locator('#input').click();check(await page.evaluate(()=>a.getElements()[0]?.text==='Canvas text'),'text commits on blur');
 check(await page.evaluate(()=>window.textReasons.join(',')==='text-commit'),'text commit reason');
 check(await page.evaluate(()=>{a.clear();a.undo();return a.getElements()[0]?.text==='Canvas text'}),'clear restores text through undo');
 check(await page.evaluate(()=>{const scene=a.getScene();a.resetHistory();return !a.getHistoryState().canUndo&&JSON.stringify(a.getScene())===JSON.stringify(scene)}),'explicit history reset preserves scene');
 // Programmatic image/node tool inputs, scene roundtrip.
 await page.evaluate(()=>{a.clear();a.setTool('image',{src:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',naturalW:40,naturalH:30})});await page.mouse.click(100,100);
 check(await page.evaluate(()=>a.getElements()[0]?.type==='image'),'image tool');
 await page.evaluate(()=>a.setTool('node',{nodeId:'test',preview:{title:'Node'}}));await page.mouse.click(300,200);
 check(await page.evaluate(()=>a.getElements()[1]?.type==='node'),'node tool');
 check(await page.evaluate(()=>{const s=a.getScene();a.clear();return a.loadScene(JSON.parse(JSON.stringify(s))).ok&&a.getElements().length===2}),'scene serialization');
 // Pan, zoom, and keyboard isolation.
 await page.evaluate(()=>{a.clear();a.setTool('pan')});await drag(100,100,150,130);check(await page.evaluate(()=>a.getCamera().x===50&&a.getCamera().y===30),'pan tool');
 await page.mouse.wheel(0,-100);await page.waitForTimeout(50);check(await page.evaluate(()=>a.getCamera().zoom>1),'wheel zoom');
 await page.evaluate(()=>{a.clear();b.clear();a.add({...rect,x:10,y:10});b.add({...rect,x:10,y:10});a.setSelection(['r']);b.setSelection(['r']);document.querySelector('#a').focus()});
 await page.keyboard.press('Delete');check(await page.evaluate(()=>a.getElements().length===0&&b.getElements().length===1),'keyboard only affects focused canvas');
 await page.locator('#input').focus();await page.keyboard.press('Control+z');check(await page.evaluate(()=>a.getElements().length===0&&b.getElements().length===1),'input undo does not affect canvases');
 // Decode exported PNGs and assert actual pixels after distant origin/camera/scale.
 const png=await page.evaluate(async()=>{
  a.clear();a.add(rect);a.setCamera({x:500,y:-900,zoom:3});
  const blob=await a.exportPNG({fitContent:true,padding:10,scale:2,transparent:true});const bitmap=await createImageBitmap(blob);const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
  return {width:c.width,height:c.height,center:[...ctx.getImageData(100,60,1,1).data],edge:[...ctx.getImageData(1,1,1,1).data]};
 });check(png.width===240&&png.height===160,'fitted PNG dimensions');check(png.center.join(',')==='255,0,0,255','fitted PNG includes distant content');check(png.edge[3]===0,'transparent PNG padding');
 const viewport=await page.evaluate(async()=>{a.clear();a.add({...rect,x:10,y:10});a.setCamera({x:20,y:30,zoom:2});const bitmap=await createImageBitmap(await a.exportPNG({scale:2}));const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();return{w:c.width,h:c.height,pixel:[...ctx.getImageData(100,120,1,1).data]}});
 check(viewport.w===1280&&viewport.h===960,'viewport PNG scale');check(viewport.pixel.join(',')==='255,0,0,255','viewport PNG camera');
 const svg=await page.evaluate(async()=>{const evil='\"><script>window.injected=1</script><rect fill="';a.clear();a.add({...rect,stroke:evil,fill:evil});a.add({...rect,id:'text',type:'text',text:'<>&',fontFamily:evil,fontSize:16,align:'left'});const scene=a.getScene();scene.background.color=evil;a.load(scene);const xml=await a.exportSVG({fitContent:true});const doc=new DOMParser().parseFromString(xml,'image/svg+xml');return{valid:!doc.querySelector('parsererror,script'),count:doc.querySelectorAll('rect').length,font:doc.querySelector('text').getAttribute('font-family')===evil,bg:doc.querySelector('rect').getAttribute('x')}});
 check(svg.valid&&svg.count===2&&svg.font,'SVG escapes text/style attributes');check(svg.bg==='980','SVG fitted background coordinates');
 await page.evaluate(()=>{a.clear();a.add({...rect,x:20,y:20,type:'node',nodeId:'async-node',variant:'card'});a.setTool('select')});
 await page.waitForFunction(()=>a.getElements()[0]?.preview?.title==='Resolved node');check(true,'node preview hook');
 await page.mouse.click(50,50);check(await page.evaluate(()=>nodeClicks.join(',')==='async-node'),'node click hook');
 await drag(50,50,100,90);check(await page.evaluate(()=>nodeClicks.length===1),'node drag does not invoke click hook');
 // CSS dimensions may differ from the canvas backing dimensions.
 await page.evaluate(()=>{a.clear();a.setTool('rectangle');const c=document.querySelector('#a');c.style.width='320px';c.style.height='240px'});
 await drag(20,20,70,50);check(await page.evaluate(()=>{const r=a.getElements()[0];return r.x===40&&r.y===40&&r.w===100&&r.h===60}),'CSS-scaled pointer coordinates');
 await page.evaluate(()=>a.setTool('pan'));await drag(100,100,120,110);check(await page.evaluate(()=>a.getCamera().x===40&&a.getCamera().y===20),'CSS-scaled pan deltas');
 await page.mouse.move(80,60);const anchor=await page.evaluate(()=>a.screenToCanvas({x:80,y:60}));await page.mouse.wheel(0,-100);await page.waitForTimeout(50);
 check(await page.evaluate(anchor=>{const after=a.screenToCanvas({x:80,y:60});return Math.abs(after.x-anchor.x)<0.001&&Math.abs(after.y-anchor.y)<0.001},anchor),'CSS-scaled wheel anchor');
 await page.evaluate(()=>a.setTool('text'));await page.mouse.click(80,60);check(await page.evaluate(()=>{const t=document.querySelector('textarea');return t&&Math.abs(parseFloat(t.style.left)-80)<0.001&&Math.abs(parseFloat(t.style.top)-60)<0.001}),'CSS-scaled text overlay');
 const limits=await page.evaluate(async()=>{
  const codes=[];for(const method of ['exportPNG','exportSVG']){try{await a[method]({scale:Number.MAX_VALUE})}catch(error){codes.push(error.code)}}return codes;
 });check(limits.join(',')==='EXPORT_RENDER_FAILED,EXPORT_RENDER_FAILED','both exports reject overflowing dimensions before allocation');
 const tainted=await page.evaluate(async url=>{
  const c=document.createElement('canvas');c.width=10;c.height=10;const errors=[];
  const drawing=new Drawfn({canvas:c,getImageBitmap:async()=>{const image=new Image();image.src=url;await image.decode();return createImageBitmap(image)}});
  drawing.on('error',error=>errors.push(error.code));drawing.add({...rect,id:'taint',type:'image',src:url,x:0,y:0,w:10,h:10});
  try{await drawing.exportPNG({scale:1});return{unexpectedSuccess:true}}catch(error){return{code:error.code,errors}}finally{drawing.destroy()}
 },`http://127.0.0.1:${imageServer.address().port}/image.png`);
 check(tainted.code==='EXPORT_RENDER_FAILED'&&tainted.errors.includes('EXPORT_RENDER_FAILED'),`native cross-origin canvas encoding failure is structured: ${JSON.stringify(tainted)}`);
 await page.evaluate(()=>{a.destroy();a.destroy();b.destroy()});check(errors.length===0,`browser errors: ${errors.join(';')}`);
 await page.goto(`http://127.0.0.1:${server.address().port}/drawfn/core/example.html`);await page.locator('#rectangle').click();const box=await page.locator('#canvas').boundingBox();await drag(Math.max(box.x,0)+30,box.y+30,Math.max(box.x,0)+100,box.y+90);await page.waitForFunction(()=>document.querySelector('#element-count').textContent==='1',{},{timeout:3000}).catch(async error=>{throw Error(JSON.stringify({errors,box,state:await page.evaluate(()=>({tool:document.querySelector('#current-tool')?.textContent,count:document.querySelector('#element-count')?.textContent,canvas:document.querySelector('#canvas')?.outerHTML}))}))});check(true,'shipped vanilla example imports and draws');check(errors.length===0,'vanilla example browser errors');
 console.log(JSON.stringify({browser:await browser.version(),assertions,pageErrors:errors}));
}finally{await browser.close();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>imageServer.close(resolve))])}
