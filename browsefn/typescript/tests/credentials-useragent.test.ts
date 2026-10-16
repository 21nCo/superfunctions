import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { browseFn } from '../src/index.js';

it('rotates target User-Agent deterministically with explicit case-insensitive header precedence', async () => {
  const seen: string[] = [];
  const server = createServer((request,response) => { seen.push(request.headers['user-agent']!); response.end('<title>OK</title>'); });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const browser = browseFn({web:{userAgents:['agent-a','agent-b']}}), url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await browser.web.getPage(url); await browser.web.getPage(url,{headers:{'uSeR-aGeNt':'explicit'}}); await browser.web.getPage(url); await browser.web.getPage(url);
    expect(seen).toEqual(['agent-a','explicit','agent-b','agent-a']);
  } finally {server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('does not persist API keys, request credentials or credential URLs in default cache records or logs', async () => {
  const directory=await mkdtemp(join(tmpdir(),'browse-credentials-'));
  const server=createServer(async (request,response)=>{let body=''; for await(const chunk of request){body+=chunk}; if(JSON.parse(body).url.includes('failure')) {response.end(JSON.stringify({success:false,error:'provider-secret-123 authorization-secret-123 cookie-secret-123'})); return;} response.setHeader('content-type','application/json');response.end(JSON.stringify({success:true,data:{html:'<p>safe response</p>'}}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const browser=browseFn({cache:{enabled:true,storage:'file',directory},web:{providers:{firecrawl:{apiKey:'provider-secret-123',endpoint:`http://127.0.0.1:${(server.address() as AddressInfo).port}`}}}});
    const options={headers:{Authorization:'authorization-secret-123'},cookies:[{name:'session',value:'cookie-secret-123'}]};
    await browser.web.getPage('https://example.com',options);
    await browser.web.getPage('https://example.com?token=url-secret-123',options);
    await expect(browser.web.getPage('https://example.com/failure',options)).rejects.toThrow();
    const files=await readdir(directory,{recursive:true});
    let persisted=''; for(const file of files){try{persisted+=await readFile(join(directory,file),'utf8');}catch{}}
    const evidence=persisted+JSON.stringify(browser.getLogs());
    for(const secret of ['provider-secret-123','authorization-secret-123','cookie-secret-123','url-secret-123']) expect(evidence).not.toContain(secret);
    expect(persisted).toContain('safe response');
  } finally {server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await rm(directory,{recursive:true,force:true});}
});
