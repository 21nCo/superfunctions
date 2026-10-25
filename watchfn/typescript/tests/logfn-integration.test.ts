import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../logfn/typescript/src/core/factory';
import { WatchFn } from '../src/core/watch-fn';

describe('LogFn attachment', () => {
  it('ingests actual parent and child logger output into stored log queries', async () => {
    const logger = createLogger({ name: 'payments', level: 'trace', sinks: [() => {}] });
    const child = logger.child({ component: 'checkout' });
    const watch = new WatchFn({ name: 'observability', storage: 'memory', infra: { enabled: false } });
    watch.use(logger, { autoIngest: true, parseStructured: true, minLevel: 'info' });
    watch.start();
    try {
      logger.debug('ignored');
      logger.info('accepted', { service: 'api', orderId: 'one' });
      child.error('payment failed', { orderId: 'two', password: 'never-store-this' });
      await logger.flush();
      const rows = await watch.logs.query({});
      expect(rows).toHaveLength(2);
      expect(rows.map((row: any) => row.message).sort()).toEqual(['accepted', 'payment failed']);
      expect(JSON.stringify(rows)).not.toContain('never-store-this');
      expect(await watch.logs.query({ level: 'error', search: 'payment failed' })).toHaveLength(1);
    } finally { await watch.stop(); }
  });
});

import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { DatabaseStorage } from '../src/storage/database';
import { QueryEngine } from '../src/query/query-engine';

describe('log index coverage', () => {
  it('retains legacy and changed-policy rows while seeking indexed scalar matches', async () => {
    const db = memoryAdapter(); const storage = new DatabaseStorage(db); const query = new QueryEngine(storage);
    for (let i = 0; i < 20; i++) await storage.add({ type: 'log', message: 'indexed', service: i === 0 ? 'match' : 'other' }, { indexFields: ['service'] });
    await storage.add({ type: 'log', message: 'legacy', service: 'match' });
    await storage.add({ type: 'log', message: 'changed', service: 'match' }, { indexFields: ['level'] });
    await storage.add({ type: 'log', message: 'null', service: null, properties: { service: 'match' } }, { indexFields: ['service'] });
    const result = await query.execute({ where: { type: 'log', service: 'match' } });
    expect(result.data.map(row => row.message).sort()).toEqual(['changed', 'indexed', 'legacy']);
    expect((await query.execute({ where: { type: 'log', service: { eq: null } } })).data.map(row => row.message)).toEqual(['null']);
  });
});


describe('LogFn ownership and privacy', () => {
  it('deduplicates attachment, drains admitted delivery, detaches and restarts without duplication', async () => {
    const logger = createLogger({ name: 'lifecycle', sinks: [() => {}] });
    const watch = new WatchFn({ name: 'watch', storage: 'memory', infra: { enabled: false } });
    const detach = watch.use(logger);
    expect(watch.use(logger)).toBe(detach);
    expect(() => watch.use(logger, { minLevel: 'error' })).toThrow('Detach');
    watch.start(); logger.info('first'); await logger.flush();
    await watch.stop(); logger.info('stopped'); await logger.flush();
    watch.start(); logger.info('restarted'); await logger.flush();
    detach(); detach(); logger.info('detached'); await logger.flush();
    expect((await watch.logs.query({})).map((row: any) => row.message)).toEqual(['first', 'restarted']);
    await watch.stop();
  });

  it('retains pending writes through stop and reports failures through both owners', async () => {
    const logger = createLogger({ name: 'failure', sinks: [() => {}], onError: () => {} });
    const watch = new WatchFn({ name: 'watch', storage: 'memory', infra: { enabled: false } });
    watch.use(logger); watch.start();
    let reject!: (reason: Error) => void;
    const write = vi.spyOn((watch as any).storage, 'add').mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    logger.error('pending'); let finished = false;
    const stopped = watch.stop().finally(() => { finished = true; });
    const observed = stopped.catch(error => error);
    await Promise.resolve(); expect(finished).toBe(false);
    reject(new Error('storage failed'));
    expect(await observed).toBeInstanceOf(AggregateError);
    await expect(logger.flush()).rejects.toThrow();
    await expect(watch.flush()).rejects.toThrow('storage operations failed');
    write.mockRestore(); await watch.stop();
  });

  it('redacts newly parsed JSON and cannot promote JSON routing fields over the log envelope', async () => {
    const logger = createLogger({ name: 'real-service', sinks: [() => {}] });
    const watch = new WatchFn({ name: 'watch', storage: 'memory', infra: { enabled: false } });
    watch.use(logger); watch.start();
    logger.info(JSON.stringify({ userId: 'private-person', type: 'trace.span', level: 'fatal', timestamp: 'bad' }));
    await logger.flush(); const [row] = await watch.logs.query({ level: 'info' });
    expect(row.type).toBe('log'); expect(row.name).toBe('real-service');
    expect(JSON.stringify(row)).not.toContain('private-person');
    expect(Number.isFinite(Date.parse(row.timestamp))).toBe(true);
    await watch.stop();
  });
});


import { readFileSync } from 'node:fs';
import { indexValue } from '../src/storage/log-index/values';
it('uses the same typed scalar keys as Python', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../python/tests/fixtures/log-index-golden.json', import.meta.url), 'utf8'));
  for (const vector of vectors) expect(indexValue(vector.value), vector.name).toEqual({ valueType: vector.valueType, valueKey: vector.valueKey });
});


it('rejects indexing through the legacy database bridge before writing', async () => {
  const insertEvent = vi.fn(async () => {});
  const storage = new DatabaseStorage({ insertEvent, queryEvents: async () => [] });
  await expect(storage.add({type:'log',service:'api'}, {indexFields:['service']})).rejects.toThrow('shared DB Adapter');
  expect(insertEvent).not.toHaveBeenCalled();
});

it('removes retained log index rows atomically with their payload', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const db = memoryAdapter();
    const storage = new DatabaseStorage(db, 'watchfn_events', undefined, {apps:['web'], defaultTtlMs:10});
    await storage.add({type:'log',service:'api',app:{name:'web'}}, {indexFields:['service']});
    expect(await db.findMany({model:'watchfn_log_index',where:[]})).toHaveLength(1);
    clock.mockReturnValue(1011);
    expect((await storage.cleanupRetention()).deleted).toBe(1);
    expect(await db.findMany({model:'watchfn_log_index',where:[]})).toHaveLength(0);
  } finally {clock.mockRestore();}
});


it('assigns trusted WatchFn application identity to attached logs for retention', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const logger = createLogger({name:'producer',sinks:[()=>{}]});
  const watch = new WatchFn({name:'web',storage:'database',database:memoryAdapter(),infra:{enabled:false},retention:{apps:['web'],defaultTtlMs:10}});
  watch.use(logger);watch.start();
  try {
    logger.info('retained',{app:{name:'spoofed'}});await logger.flush();
    expect((await watch.logs.query({}))[0].app).toEqual({name:'web'});
    clock.mockReturnValue(1011);expect((await watch.cleanupRetention()).deleted).toBe(1);
  } finally {await watch.stop();clock.mockRestore();}
});


import {MemoryStorage} from '../src/storage/memory-storage';
it('rejects invalid Unicode index scalars before mutating memory storage', () => {
  const storage = new MemoryStorage();
  expect(() => storage.add({type:'log',service:'\ud800'},{indexFields:['service']})).toThrow('Unicode');
  expect(storage.getAll()).toEqual([]);
});


it('rejects expanded structured log envelopes before acknowledging an unreadable event', async () => {
  const logger = createLogger({name:'large',sinks:[()=>{}],onError:()=>{}});
  const watch = new WatchFn({name:'watch',storage:'database',database:memoryAdapter(),infra:{enabled:false}});
  watch.use(logger);watch.start();
  try {
    logger.info('valid producer event',{service:'api',blob:'x'.repeat(24000)});
    await expect(logger.flush()).rejects.toThrow();
    expect(await watch.logs.query({})).toEqual([]);
  } finally {await watch.stop();}
});


import {normalizeLogBatch, resolveLogFnOptions} from '../src/integrations/logfn';
it('bounds the complete normalized batch before admission', () => {
  const event = {name:'batch',ts:'2026-10-25T00:00:00Z',level:'info' as const,msg:'large context',ctx:{blob:'x'.repeat(20000)}};
  expect(() => normalizeLogBatch(Array(300).fill(event), resolveLogFnOptions(undefined, undefined))).toThrow('Normalized LogFn batch exceeds 16MiB');
});


it('rejects oversized indexed database writes and rolls back oversized legacy backfills', async () => {
  const db=memoryAdapter();const storage=new DatabaseStorage(db);
  const oversized={type:'log',service:'api',message:'x'.repeat(65536)};
  await expect(storage.add(oversized,{indexFields:['service']})).rejects.toThrow('64KiB');
  expect(await storage.getAll()).toEqual([]);
  await storage.add(oversized);
  await expect(storage.backfillLogIndexes(['service'])).rejects.toThrow('payload limit');
  expect(await db.findMany({model:'watchfn_log_index',where:[]})).toEqual([]);
});
