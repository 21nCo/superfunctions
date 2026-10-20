/** Actual Chrome campaign content and CTA acceptance. Build SDK first. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.USERFN_PLAYWRIGHT_MODULE ?? 'playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const directory=await mkdtemp(join(tmpdir(),'userfn-renderer-browser-'));
let browser, server;
const baseline=process.argv.includes('--expect-vulnerable');
try {
 execFileSync(join(root,'node_modules/.bin/esbuild'),[join(root,'userfn/typescript/dist/index.js'),'--bundle','--format=esm','--platform=browser','--outfile='+join(directory,'sdk.js')],{stdio:'pipe'});
 const bundle=await readFile(join(directory,'sdk.js'));
 server=createServer((request,response)=>{response.setHeader('content-type',request.url==='/sdk.js'?'text/javascript':'text/html');response.end(request.url==='/sdk.js'?bundle:'<!doctype html><title>Campaign renderer acceptance</title>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.USERFN_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage(); page.setDefaultTimeout(3000); await page.goto(origin);
 await page.evaluate(async()=>{const {UserFnClient}=await import('/sdk.js'); globalThis.c=new UserFnClient({apiKey:'unused'});c.identify('test');globalThis.render=(kind,content)=>{document.querySelectorAll('.userfn-overlay').forEach(node=>node.remove());globalThis.currentCampaign={id:crypto.randomUUID(),kind,enabled:true,triggers:[{type:'event',pattern:'show'}],content};c.setCampaigns([currentCampaign]);c.trigger('event','show');};globalThis.executed=[];});
 const hostile={title:'<img src="/missing-title" onerror="globalThis.executed.push(\'title\')">',body:'<img src="/missing-body" onerror="globalThis.executed.push(\'body\')">'};
 await page.evaluate(content=>render('inbox-item',content),hostile);
 if(baseline) await page.waitForFunction(()=>executed.includes('title')&&executed.includes('body'));
 else await page.waitForTimeout(100);
 const contentResult=await page.evaluate(()=>({executed:[...executed],images:document.querySelectorAll('img').length,svg:document.querySelectorAll('svg').length,text:document.body.textContent}));
 if(baseline){assert.deepEqual([...contentResult.executed].sort(),['body','title']);}
 else {assert.deepEqual(contentResult.executed,[]);assert.equal(contentResult.images,0);assert.equal(contentResult.svg,0);assert.ok(contentResult.text.includes(hostile.title));assert.ok(contentResult.text.includes(hostile.body));}
 await page.evaluate(()=>render('modal',{title:'CTA',body:'body',ctaText:'Open',ctaUrl:'javascript:globalThis.executed.push("cta")'}));
 await page.getByText('Open',{exact:true}).click();
 if(baseline) await page.waitForFunction(()=>executed.includes('cta'));
 else await page.waitForTimeout(50);
 assert.equal(await page.evaluate(()=>executed.includes('cta')),baseline);
 if(!baseline){
   await page.evaluate(()=>render('inbox-item',{title:'Toast safe',body:'Literal body',ctaUrl:'#toast'}));
   await page.getByText('Toast safe',{exact:true}).click();await page.waitForURL(origin+'/#toast');
   await page.evaluate(()=>history.replaceState(null,'','/'));
   await page.evaluate(()=>{render('modal',{title:'Mutation',body:'body',ctaText:'Mutated action',ctaUrl:'/safe'});currentCampaign.content.ctaUrl='javascript:globalThis.executed.push("mutation")';});
   await page.getByText('Mutated action',{exact:true}).click();assert.equal(await page.evaluate(()=>executed.includes('mutation')),false);assert.equal(page.url(),origin+'/');
   for(const value of ['data:text/html,<script>globalThis.executed.push("data")</script>','\tjava\nscript:globalThis.executed.push("control")','vbscript:msgbox(1)','file:///tmp/userfn','blob:https://example.test/id']){
     await page.evaluate(url=>render('modal',{title:'Unsafe',body:'body',ctaText:'Unsafe action',ctaUrl:url}),value);await page.getByText('Unsafe action',{exact:true}).click();assert.equal(page.url(),origin+'/');
   }
   await page.evaluate(()=>render('modal',{title:'Plain',body:'**literal** <strong>text</strong>',ctaText:'Go',ctaUrl:'/accepted?from=cta#ok'}));
   assert.equal(await page.locator('.userfn-body').textContent(),'**literal** <strong>text</strong>');
   await Promise.all([page.waitForURL(origin+'/accepted?from=cta#ok'),page.getByText('Go',{exact:true}).click()]);
 }
 console.log(JSON.stringify({browser:await browser.version(),mode:baseline?'confirmed-vulnerable-baseline':'safe-renderer',hostileTitleAndBody:baseline?'executed':'literal-text',javascriptCTA:baseline?'executed':'blocked',relativeHttpCTA:!baseline}));
} finally {await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(directory,{recursive:true,force:true});}
