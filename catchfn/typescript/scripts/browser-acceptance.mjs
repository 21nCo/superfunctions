import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium, webkit } = require('playwright');
const temporary = await mkdtemp(join(tmpdir(), 'catchfn-browser-'));
const root = resolve(new URL('../../..', import.meta.url).pathname);
const outfile = join(temporary, 'app.js');
await build({stdin:{contents:`import {catchFn} from './catchfn/typescript/src/index.ts';window.events=[];window.catcher=catchFn({name:'acceptance',enableConsoleCapture:true,reporter:{floatingButton:true,hotkey:'alt+b',maxInlineBytes:2000000},maxPayloadSize:3000000,watch:{client:{capture:async event=>{window.events.push(event);}}}});`,resolveDir:root},bundle:true,platform:'browser',format:'iife',outfile});
const server=createServer(async(req,res)=>{if(req.url==='/app.js'){res.setHeader('content-type','application/javascript');res.end(await readFile(outfile));}else{res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><div data-catchfn-mask style="position:fixed;left:10px;top:10px;width:100px;height:40px;background:white;color:red">PRIVATE VALUE</div><button id="outside">Outside</button><script src="/app.js"></script></body></html>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try {
 for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true,...(name==="chromium"?{channel:"chrome"}:(process.env.CATCHFN_WEBKIT_EXECUTABLE?{executablePath:process.env.CATCHFN_WEBKIT_EXECUTABLE}:{}))});
  try{
   const page=await browser.newPage({viewport:{width:800,height:600}});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`http://127.0.0.1:${server.address().port}`);
   await page.getByRole('button',{name:'Report a bug',exact:true}).focus();
   await page.getByRole('button',{name:'Report a bug',exact:true}).click();
   await page.getByRole('dialog').waitFor();
   assert.equal(await page.locator('input[name=title]').evaluate(e=>e===document.activeElement),true);
   await page.keyboard.press('Shift+Tab');
   assert.equal(await page.getByRole('button',{name:'Cancel'}).evaluate(e=>e===document.activeElement),true);
   await page.keyboard.press('Tab');
   await page.locator('input[name=title]').fill('Browser acceptance');
   await page.locator('textarea[name=steps]').fill('Open page\nClick control');
   await page.locator('input[name=console]').uncheck();
   const canvas=page.getByLabel('Screenshot annotation canvas');
   await page.waitForTimeout(250);
   await page.getByRole('button',{name:'Box',exact:true}).click();
   await canvas.scrollIntoViewIfNeeded();
   const bounds=await canvas.boundingBox();
   await page.mouse.move(bounds.x+120,bounds.y+80);await page.mouse.down();await page.mouse.move(bounds.x+180,bounds.y+120,{steps:4});await page.mouse.up();
   await page.getByRole('button',{name:'Submit report',exact:true}).click();
   await page.getByRole('status').filter({hasText:'Report submitted.'}).waitFor();
   const report=await page.evaluate(()=>window.events[0]);
   assert.equal(report.type,'bug_report');assert.deepEqual(report.report.steps,['Open page','Click control']);assert.equal(report.context.console,undefined);
   assert.ok(report.attachments[0].annotationScene.elements.some(e=>e.type==='rectangle'));
   assert.ok(report.attachments[0].annotationScene.elements.every(e=>e.type!=='image'));
   const maskedPixel=await page.evaluate(async dataUrl=>{const image=new Image();image.src=dataUrl;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(16,16,1,1).data];},report.attachments[0].dataUrl);
   assert.ok(maskedPixel.slice(0,3).every(channel=>channel<40),'private element must be masked in exported screenshot');
   await page.getByRole('button',{name:'Close',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'Report a bug',exact:true}).evaluate(e=>e===document.activeElement),true);
   await page.keyboard.press('Alt+b');await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
   await page.evaluate(()=>window.catcher.stop());assert.equal(await page.getByRole('button',{name:'Report a bug',exact:true}).count(),0);
   assert.deepEqual(errors,[]);console.log(`${name}: reporter, DrawFn rectangle, consent, canonical client handoff, hotkey and focus lifecycle passed (injected transport)`);
  }finally{await browser.close();}
 }
}finally{await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}
