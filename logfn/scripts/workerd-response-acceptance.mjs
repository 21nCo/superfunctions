import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
// Use an explicitly selected existing local runtime; no downloads or deployments.
const runtimePath = process.env.LOGFN_MINIFLARE;
if (!runtimePath) throw new Error('Set LOGFN_MINIFLARE to an installed miniflare package');
const { Miniflare, convertV4MiniflareOptions } = require(runtimePath);
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = `
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { requestLogger as honoLogger } from './logfn/typescript/src/http/hono.ts';
import { requestLogger as sharedLogger } from './logfn/typescript/src/http/shared.ts';
import { createRouter } from '@superfunctions/http';
import { Logger } from './logfn/typescript/src/core/logger.ts';
const events=[];
const logger=new Logger({name:'upgrade',sinks:[batch=>events.push(...batch)]});
const hono=new Hono();
hono.use(honoLogger({logger}));
hono.get('/hono',upgradeWebSocket(()=>({onMessage(event,ws){ws.send('echo:'+event.data)},onClose(_event,ws){ws.close()}})));
const shared=createRouter({middleware:[sharedLogger({logger})],routes:[{method:'GET',path:'/shared',handler:()=>{
 const pair=new WebSocketPair(); pair[1].accept(); pair[1].addEventListener('message',event=>pair[1].send('echo:'+event.data)); pair[1].addEventListener('close',()=>pair[1].close());
 return new Response(null,{status:101,webSocket:pair[0]});
}}]});
export default {async fetch(request){
 const path=new URL(request.url).pathname;
 if(path==='/events')return Response.json(events);
 return path==='/hono'?hono.fetch(request):shared.handle(request);
}};`;
const bundle = await build({ stdin: { contents: source, resolveDir: root, sourcefile: 'logfn-workerd-response.ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const options = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-23' };
const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
const sockets = [];
try {
  for (const path of ['/hono', '/shared']) {
    const response = await mf.dispatchFetch('http://local' + path, { headers: { Upgrade: 'websocket', traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' } });
    assert.equal(response.status, 101, path);
    assert.ok(response.webSocket, path + ' retains WebSocket');
    assert.equal(response.headers.get('x-trace-id'), '0af7651916cd43dd8448eb211c80319c');
    const socket = response.webSocket; sockets.push(socket); socket.accept();
    const message = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket echo timed out')), 3000);
      socket.addEventListener('message', event => { clearTimeout(timer); resolve(event.data); }, { once: true });
    });
    socket.send(path); assert.equal(await message, 'echo:' + path);
    const events = await (await mf.dispatchFetch('http://local/events')).json();
    const matching = events.filter(event => event.requestId === response.headers.get('x-request-id'));
    assert.equal(matching.length, 2);
    assert.equal(matching[1].ctx.statusCode, 101);
    socket.close(1000, 'fixture complete');
  }
  console.log('native workerd Hono/shared WebSocket upgrades, echo and correlation passed');
} finally {
  for (const socket of sockets) { try { socket.close(1000, 'fixture cleanup'); } catch {} }
  await mf.dispose();
}
