/** Executed only inside the isolated Linux image. Keep self-contained for packaging. */
export const browserWorkerSource = String.raw`
const net = require('node:net');
const peers = new Map();
let browser, proxy, controlPort, controlPath, next = 0, input = '';
const MAX = 32;
function send(frame) {
  if (!process.stdout.write(JSON.stringify(frame) + '\n')) for (const socket of peers.values()) socket.pause();
}
process.stdout.on('drain', () => { for (const socket of peers.values()) socket.resume(); });
function attach(id, socket) {
  if (peers.size >= MAX || peers.has(id)) { socket.destroy(); throw new Error('Broker connection limit'); }
  peers.set(id, socket);
  socket.on('data', chunk => { for (let i=0;i<chunk.length;i+=32768) send({type:'data',id,data:chunk.subarray(i,i+32768).toString('base64')}); });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => { peers.delete(id); send({type:'close',id}); });
}
async function initialize(frame) {
  proxy = net.createServer(socket => { const id='e'+(++next); attach(id,socket); send({type:'open',id}); });
  await new Promise(resolve => proxy.listen(0,'127.0.0.1',resolve));
  const proxyUrl='http://127.0.0.1:'+proxy.address().port;
  if (frame.provider === 'playwright') {
    const pw=require('/opt/browse-worker/node_modules/playwright');
    browser=await pw[frame.engine].launchServer({headless:true,proxy:{server:proxyUrl},
      ...(frame.engine==='chromium'?{args:['--proxy-bypass-list=<-loopback>']}:{}),
      ...(frame.engine==='firefox'?{firefoxUserPrefs:{'network.proxy.allow_hijacking_localhost':true}}:{})});
  } else {
    const pw=require('/opt/browse-worker/node_modules/playwright');
    const pp=require('/opt/browse-worker/node_modules/puppeteer-core');
    browser=await pp.launch({headless:true,executablePath:pw.chromium.executablePath(),
      args:['--no-sandbox','--disable-component-update','--disable-field-trial-config','--no-default-browser-check','--proxy-server='+proxyUrl,'--proxy-bypass-list=<-loopback>'],
      debuggingPort:0});
  }
  const endpoint=new URL(browser.wsEndpoint());
  controlPort=Number(endpoint.port);controlPath=endpoint.pathname+endpoint.search;
  send({type:'ready',path:controlPath});
}
process.stdin.on('data', chunk => {
  input+=chunk.toString();
  if(input.length>262144 && !input.includes('\n')) process.exit(2);
  let end;
  while((end=input.indexOf('\n'))>=0) {
    const line=input.slice(0,end);input=input.slice(end+1);
    if(line.length>131072) process.exit(2);
    let frame;try { frame=JSON.parse(line); } catch { process.exit(2); }
    if(frame.type==='init') initialize(frame).catch(()=>{send({type:'failure'});process.exit(2);});
    else if(frame.type==='open' && /^c\d+$/.test(frame.id) && controlPort) attach(frame.id,net.connect(controlPort,'127.0.0.1'));
    else if(frame.type==='data' && typeof frame.data==='string') {
      const socket=peers.get(frame.id); if(socket && !socket.write(Buffer.from(frame.data,'base64'))) {
        process.stdin.pause();socket.once('drain',()=>process.stdin.resume());socket.once('close',()=>process.stdin.resume());
      }
    } else if(frame.type==='close') peers.get(frame.id)?.destroy();
    else process.exit(2);
  }
});
process.stdin.on('end',()=>process.exit(0));
`;
