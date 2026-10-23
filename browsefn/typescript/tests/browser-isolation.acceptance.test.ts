import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createSocket } from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { PlaywrightProvider } from '../src/web/providers/playwright.js';
import { WebScraper } from '../src/web/scraper.js';
import { createBrowseFnRouter } from '../src/router/http-router.js';
import { PuppeteerProvider } from '../src/web/providers/puppeteer.js';
import { isPublicAddress } from '../src/utils/destination-policy.js';
vi.mock('../src/utils/destination-policy.js', async original => { const real = await original<typeof import('../src/utils/destination-policy.js')>(); return { ...real, isPublicAddress: vi.fn(real.isPublicAddress) }; });
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => { throw new Error('Only owned literal-IP fixtures are permitted'); }) }));
const image = process.env.BROWSEFN_ISOLATION_IMAGE;
// Opt-in native Docker acceptance. Unit suites never manufacture a passing browser receipt.
describe.skipIf(!image)('Docker browser network isolation', () => {
  let publicServer: Server, privateServer: Server, allowed: string, denied: string;
  const privateRequests: string[] = [];
  const receivedHeaders: Array<import('node:http').IncomingHttpHeaders> = [];
  const fixtureSockets = new Set<import('node:net').Socket>();
  beforeAll(async () => {
    privateServer=createServer((req,res)=>{privateRequests.push(req.url!);res.end('PRIVATE TARGET');});
    privateServer.listen(0,'::1');await once(privateServer,'listening');
    denied=`http://[::1]:${(privateServer.address() as {port:number}).port}`;
    publicServer=createServer((req,res)=>{
      if(req.url==='/page') receivedHeaders.push(req.headers);
      if(req.url==='/expanded-page'){res.setHeader('content-type','text/html; charset=utf-8');res.end('<html><body><script>document.body.append("é".repeat(6*1024*1024))</script></body></html>');return;}
      if(req.url==='/redirect'){res.writeHead(302,{location:'/page'}).end();return;}
      if(req.url==='/private-redirect'){res.writeHead(302,{location:denied+'/redirected'}).end();return;}
      if(req.url==='/private-subresource'){res.end(`<html><img src="${denied}/image"><script>fetch('${denied}/fetch').catch(()=>{})</script></html>`);return;}
      if(req.url==='/sw.js'){res.setHeader('content-type','application/javascript');res.end(`self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));self.addEventListener('fetch',event=>{if(event.request.url.endsWith('/via-worker'))event.respondWith(fetch('${denied}/worker'));});`);return;}
      if(req.url==='/script.js'){res.setHeader('content-type','application/javascript');res.end('document.title="JavaScript and subresource ran"');return;}
      res.setHeader('content-type','text/html');res.end('<html><title>Owned page</title><script src="/script.js"></script><body>Browser works</body></html>');
    });
    publicServer.on('upgrade',(req,socket)=>{
      const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.concat([Buffer.from([0x81,5]),Buffer.from('owned')]));socket.on('error',()=>{});
    });
    for(const server of [publicServer,privateServer]) server.on('connection',socket=>{fixtureSockets.add(socket);socket.once('close',()=>fixtureSockets.delete(socket));});
    publicServer.listen(0,'127.0.0.1');await once(publicServer,'listening');
    allowed=`http://127.0.0.1:${(publicServer.address() as {port:number}).port}`;
    // Only this owned fixture IP is classified public. Actual denied target stays private.
    vi.mocked(isPublicAddress).mockImplementation(address=>address==='127.0.0.1');
  });
  afterAll(async()=>{
    for(const socket of fixtureSockets) socket.destroy();
    for(const server of [publicServer,privateServer]) {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  for(const engine of ['chromium','firefox','webkit'] as const) {
    it(`${engine}: renders allowed JavaScript/subresources and screenshot through isolated proxy`,async()=>{
      const provider=new PlaywrightProvider({browser:engine,isolation:{dockerImage:image!}});
      const page=await provider.getPage(allowed+'/redirect',{security:{},cache:false,screenshot:true,timeout:45_000});
      expect(page.metadata.title).toBe('JavaScript and subresource ran');expect(page.url).toBe(allowed+'/page');expect(page.screenshot!.length).toBeGreaterThan(100);
      expect(privateRequests).toEqual([]);
    },60_000);
    it(`${engine}: denies private redirects and subresources without a target request`,async()=>{
      const provider=new PlaywrightProvider({browser:engine,isolation:{dockerImage:image!}});
      for(const path of ['/private-redirect','/private-subresource']) {
        await expect(provider.getPage(allowed+path,{security:{},cache:false,waitFor:'networkidle',timeout:45_000})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
      }
      expect(privateRequests).toEqual([]);
    },120_000);
  }
  it('image-only global caps retain isolated browser page functionality',async()=>{
    for(const provider of [new PlaywrightProvider({isolation:{dockerImage:image!}}),new PuppeteerProvider({isolation:{dockerImage:image!}})]) {
      const page=await provider.getPage(allowed+'/page',{security:{maxDownloadBytes:16},timeout:30_000});
      expect(page.metadata.title).toBe('JavaScript and subresource ran');
    }
  },90_000);
  it('Puppeteer: preserves page scripting, cookies, headers and screenshots',async()=>{
    const provider=new PuppeteerProvider({isolation:{dockerImage:image!}});
    const page=await provider.getPage(allowed+'/page',{security:{},screenshot:true,headers:{'x-owned':'fixture'},cookies:[{name:'owned',value:'yes',domain:'127.0.0.1'}],timeout:30_000});
    expect(page.metadata.title).toBe('JavaScript and subresource ran');expect(page.screenshot!.length).toBeGreaterThan(100);
    expect(receivedHeaders.some(headers=>headers['x-owned']==='fixture'&&headers.cookie?.includes('owned=yes'))).toBe(true);
    const title=await provider.scrape(allowed+'/page',{security:{},timeout:30_000,script:async (page:any)=>page.title()});
    expect(title).toBe('JavaScript and subresource ran');
    await expect(provider.getPage(allowed+'/private-subresource',{security:{},waitFor:'networkidle',timeout:30_000})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
    expect(privateRequests).toEqual([]);
  },90_000);
  it('preserves HTTPS certificate verification for every isolated browser provider',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'browsefn-tls-'));
    let server:ReturnType<typeof createHttpsServer>|undefined;
    const sockets=new Set<import('node:net').Socket>();let requests=0;
    try {
      execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=untrusted.invalid'],{stdio:'ignore'});
      server=createHttpsServer({key:readFileSync(join(directory,'key.pem')),cert:readFileSync(join(directory,'cert.pem'))},(_req,res)=>{requests++;res.end('must not be read');});
      server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
      server.listen(0,'127.0.0.1');await once(server,'listening');
      const url=`https://127.0.0.1:${(server.address() as {port:number}).port}`;
      const providers=[...(['chromium','firefox','webkit'] as const).map(browser=>new PlaywrightProvider({browser,isolation:{dockerImage:image!}})),new PuppeteerProvider({isolation:{dockerImage:image!}})];
      for(const provider of providers) await expect(provider.getPage(url,{security:{},timeout:30_000})).rejects.toThrow(/cert|SSL|issuer|certificate/i);
      expect(requests).toBe(0);
    } finally {
      for(const socket of sockets)socket.destroy();
      if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
      rmSync(directory,{recursive:true,force:true});
    }
  },120_000);
  it('fails closed for browser hostname rules without disabling the default isolated path',async()=>{
    for(const provider of [new PlaywrightProvider({isolation:{dockerImage:image!}}),new PuppeteerProvider({isolation:{dockerImage:image!}})]) {
      for(const security of [{allowedHosts:['127.0.0.1']},{allowPrivateHosts:true,blockedHosts:['elsewhere.test']}]) {
        await expect(provider.getPage(allowed+'/page',{security,timeout:30_000})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
      }
    }
    expect(privateRequests).toEqual([]);
    expect(execFileSync('docker',['ps','-aq','--filter','name=browsefn-'],{encoding:'utf8'}).trim()).toBe('');
  });
  it('rejects decoded DOM growth beyond10MiB before returning a browser page',async()=>{
    const provider=new PlaywrightProvider({isolation:{dockerImage:image!}});
    await expect(provider.getPage(allowed+'/expanded-page',{security:{},timeout:30_000})).rejects.toMatchObject({code:'DOWNLOAD_TOO_LARGE'});
    expect(execFileSync('docker',['ps','-aq','--filter','name=browsefn-'],{encoding:'utf8'}).trim()).toBe('');
  },45_000);
  it('allows public WebSockets through the pinned proxy',async()=>{
    const provider=new PlaywrightProvider({isolation:{dockerImage:image!}});
    const message=await provider.scrape(allowed+'/page',{security:{},timeout:30_000,script:async(page:any)=>page.evaluate((url:string)=>new Promise((resolve,reject)=>{
      const socket=new WebSocket(url);socket.onmessage=event=>{resolve(event.data);socket.close();};socket.onerror=()=>reject(new Error('WebSocket failed'));
    }),allowed.replace('http:','ws:')+'/socket')});
    expect(message).toBe('owned');
  },45_000);
  it('denies service-worker fetches outside page routing',async()=>{
    const provider=new PlaywrightProvider({isolation:{dockerImage:image!}});
    await expect(provider.scrape(allowed+'/page',{security:{},timeout:30_000,script:async(page:any)=>{
      await page.evaluate(async()=>{
        await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
        if(!navigator.serviceWorker.controller) await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));
        await fetch('/via-worker').catch(()=>{});
      });
    }})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
    expect(privateRequests).toEqual([]);
  },45_000);
  it('enforces network-none against raw TCP and UDP bypass attempts to owned host listeners',async()=>{
    const address=Object.values(networkInterfaces()).flat().find(value=>value?.family==='IPv4'&&!value.internal)?.address;
    expect(address).toBeDefined();
    let tcpCalls=0,udpCalls=0;
    const tcp=createServer((_req,res)=>{tcpCalls++;res.end('owned host');});tcp.listen(0,address);await once(tcp,'listening');
    const udp=createSocket('udp4');udp.on('message',()=>udpCalls++);udp.bind(0,address);await once(udp,'listening');
    try {
      const provider=new PlaywrightProvider({isolation:{dockerImage:image!}});
      await provider.scrape(allowed+'/page',{security:{},timeout:30_000,script:async()=>{
        const names=execFileSync('docker',['ps','--filter','name=browsefn-','--format','{{.Names}}'],{encoding:'utf8'}).trim().split('\n');expect(names).toHaveLength(1);
        const details=JSON.parse(execFileSync('docker',['inspect',names[0]],{encoding:'utf8'}))[0];
        expect(details.HostConfig.NetworkMode).toBe('none');expect(details.HostConfig.CapDrop).toContain('ALL');expect(details.HostConfig.ReadonlyRootfs).toBe(true);expect(details.HostConfig.LogConfig.Type).toBe('none');expect(details.HostConfig.MemorySwap).toBe(details.HostConfig.Memory);
        const script=`const net=require('net'),udp=require('dgram').createSocket('udp4');const [host,tcpPort,udpPort]=process.argv.slice(1);let results={};const tcp=net.connect(Number(tcpPort),host);tcp.on('connect',()=>tcp.end('GET / HTTP/1.1\\r\\nHost: owned\\r\\nConnection: close\\r\\n\\r\\n'));tcp.on('error',error=>{results.tcp=error.code;});tcp.on('close',()=>udp.send(Buffer.from('owned-dns-udp-probe'),Number(udpPort),host,error=>{results.udp=error?.code;udp.close();console.log(JSON.stringify(results));}));setTimeout(()=>process.exit(2),3000).unref();`;
        const result=JSON.parse(execFileSync('docker',['exec',names[0],'node','-e',script,address!,String((tcp.address() as {port:number}).port),String(udp.address().port)],{encoding:'utf8',timeout:5000}));
        expect(result).toEqual({tcp:'ENETUNREACH',udp:'ENETUNREACH'});
      }});
      expect(tcpCalls).toBe(0);expect(udpCalls).toBe(0);
    } finally {tcp.closeAllConnections();await new Promise<void>(resolve=>tcp.close(()=>resolve()));await new Promise<void>(resolve=>udp.close(()=>resolve()));}
  },45_000);
  it('admits the configured browser through the real router and overrides private-host/cache options',async()=>{
    const service=new WebScraper(undefined,undefined,'playwright');
    service.registerProvider(new PlaywrightProvider({isolation:{dockerImage:image!}}));
    const router=createBrowseFnRouter({web:service} as never);
    const call=(url:string)=>router.handle(new Request('http://owned-router.test/web/page',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,options:{provider:'playwright',timeout:30_000,security:{allowPrivateHosts:true},cache:{key:'caller-override'}}})}));
    const response=await call(allowed+'/page');expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,data:{provider:'playwright',metadata:{title:'JavaScript and subresource ran'}}});
    const refused=await call(denied+'/direct');expect(refused.status).toBe(403);expect(privateRequests).toEqual([]);
  },45_000);
  it('fails closed without trusted isolation and never uses custom fallback after policy denial',async()=>{
    const unsafe=new WebScraper(undefined,undefined,'playwright');unsafe.registerProvider(new PlaywrightProvider());
    await expect(unsafe.getPage(allowed,{security:{},cache:false})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
    const service=new WebScraper(undefined,undefined,'playwright',['custom']);
    service.registerProvider(new PlaywrightProvider({isolation:{dockerImage:image!}}));
    const fallback=vi.fn();service.registerProvider({name:'custom',isAvailable:async()=>true,getPage:fallback} as never);
    await expect(service.getPage(allowed+'/private-redirect',{security:{},cache:false,retry:{count:2,delay:0}})).rejects.toMatchObject({code:'SECURITY_POLICY_BLOCKED'});
    expect(fallback).not.toHaveBeenCalled();expect(privateRequests).toEqual([]);
  },45_000);
  it('bounds a stalled page callback and confirms worker cleanup',async()=>{
    const provider=new PlaywrightProvider({isolation:{dockerImage:image!}});
    const started=Date.now();
    await expect(provider.scrape(allowed+'/page',{security:{},timeout:2500,script:()=>new Promise(()=>{})})).rejects.toMatchObject({code:'UPSTREAM_TIMEOUT'});
    expect(Date.now()-started).toBeLessThan(10_000);
    expect(execFileSync('docker',['ps','-a','--filter','name=browsefn-','--format','{{.Names}}'],{encoding:'utf8'}).trim()).toBe('');
  },15_000);
  it('fails without pulling an absent worker image and leaves no container',async()=>{
    const provider=new PlaywrightProvider({isolation:{dockerImage:'browsefn-deliberately-absent:acceptance'}});
    await expect(provider.getPage(allowed,{security:{},timeout:10_000})).rejects.toMatchObject({code:'PROVIDER_UNAVAILABLE'});
    expect(execFileSync('docker',['ps','-a','--filter','name=browsefn-','--format','{{.Names}}'],{encoding:'utf8'}).trim()).toBe('');
  },15_000);
  it('leaves no owned browser containers after operations',()=>{
    expect(execFileSync('docker',['ps','-a','--filter','name=browsefn-','--format','{{.Names}}'],{encoding:'utf8'}).trim()).toBe('');
  });
});
