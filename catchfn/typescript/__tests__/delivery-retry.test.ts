import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { catchFn, CatchFnDeliveryError } from '../src/index.js';

it('retries the same queued snapshot after HTTP failure, without hooks/uploads or extra events', async () => {
  let status = 503; const arrivals: string[] = []; let hooks = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    arrivals.push(Buffer.concat(chunks).toString());
    res.writeHead(status); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const catcher = catchFn({ name: 'retry', watch: { endpoint: `http://127.0.0.1:${(server.address() as {port:number}).port}`, retries: 0 }, beforeSend: event => { hooks++; return event; } });
  try {
    const failure = await catcher.captureBug({ title: 'Original snapshot' }).catch(error => error);
    expect(failure).toBeInstanceOf(CatchFnDeliveryError); expect(failure.status).toBe(503);
    await expect(failure.retry()).rejects.toBe(failure);
    status = 202;
    const [first, second] = await Promise.all([failure.retry(), failure.retry()]);
    expect(first.id).toBe(failure.reportId); expect(second.id).toBe(first.id); expect(first.delivery).toBe('sent');
    expect(arrivals).toHaveLength(3); expect(new Set(arrivals).size).toBe(1); expect(hooks).toBe(1);
    await failure.retry(); await catcher.flush(); expect(arrivals).toHaveLength(3);
  } finally { catcher.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('does not claim a queue-full report was sent merely because an older queued report flushed', async () => {
  let status = 503; const arrivals: Array<Array<{id:string}>> = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    arrivals.push(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(status); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const catcher = catchFn({name:'queue',watch:{endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}`,retries:0,maxQueueSize:1}});
  try {
    const first = await catcher.captureBug({title:'First'}).catch(error=>error);
    const second = await catcher.captureBug({title:'Second'}).catch(error=>error);
    expect(second).toBeInstanceOf(CatchFnDeliveryError);
    status=202; await first.retry();
    const sent=await second.retry(); expect(sent.id).toBe(second.reportId); expect(sent.id).not.toBe(first.reportId);
    expect(arrivals.map(batch=>batch[0].id)).toEqual([first.reportId,first.reportId,second.reportId]);
  } finally { catcher.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('preserves identity for injected transports and does not turn preparation errors into delivery retries', async () => {
  const events: unknown[]=[]; let online=false;
  const catcher=catchFn({name:'injected',watch:{client:{capture:async event=>{events.push(event);if(!online)throw Error('offline');return {integration:{issueId:'one'}};}}}});
  try {
    const error=await catcher.captureBug({title:'Injected'}).catch(error=>error); online=true;
    expect((await error.retry()).integration.issueId).toBe('one'); expect(events[0]).toEqual(events[1]);
    const invalid=catchFn({name:'invalid',beforeSend:()=>{throw Error('hook failed');}});
    const preparation=await invalid.captureBug({title:'Invalid'}).catch(error=>error);
    expect(preparation).not.toBeInstanceOf(CatchFnDeliveryError); invalid.stop();
  } finally {catcher.stop();}
});
