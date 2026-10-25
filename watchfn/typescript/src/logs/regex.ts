import { Worker } from 'node:worker_threads';
import type { AlertChannel } from '../alerts/types';
import type { StorageAdapter } from '../storage/types';
import { scanCanonicalLogs } from './patterns';
import { logField } from '../storage/log-index/values';

export interface SerializedLogPattern {engine: 'ecmascript'; source: string; flags: string}
export interface CreateLogPatternOptions {
  name: string; pattern: RegExp; threshold: {count: number; window: string};
  alert: {enabled: boolean; severity?: 'info' | 'warning' | 'error' | 'critical'; channels: string[]};
}
export function validateLogPattern(pattern: SerializedLogPattern): void {
  if (!pattern || pattern.engine !== 'ecmascript' || typeof pattern.source !== 'string' || Buffer.byteLength(pattern.source) > 4096 || Buffer.from(pattern.source).toString('utf8') !== pattern.source || typeof pattern.flags !== 'string' || !/^[dgimsuy]*$/.test(pattern.flags) || new Set(pattern.flags).size !== pattern.flags.length) throw new TypeError('Invalid log pattern source or Node18 flags');
  new RegExp(pattern.source, pattern.flags); // Compilation only; arbitrary matching stays off the main thread.
}
export function namedPatternChannels(names: string[], configured?: Record<string, AlertChannel>): AlertChannel[] {
  if (!Array.isArray(names) || names.length > 10 || new Set(names).size !== names.length) throw new TypeError('Invalid named alert channels');
  return names.map(name => {
    if (typeof name !== 'string' || !configured || !Object.hasOwn(configured, name)) throw new TypeError(`Unknown named alert channel: ${String(name)}`);
    return structuredClone(configured[name]);
  });
}
let activeWorkers = 0;
const source = `const {parentPort,workerData}=require('node:worker_threads');
const regex=new RegExp(workerData.pattern.source,workerData.pattern.flags);
let count=0; for(const value of workerData.values){regex.lastIndex=0;if(regex.test(value))count++;}
parentPort.postMessage(count);`;

/** Deadline covers worker startup and execution; cleanup waits for owned termination. */
export async function countRegexValues(pattern: SerializedLogPattern, values: string[]): Promise<number> {
  validateLogPattern(pattern);
  let bytes = 0;
  if (values.length > 10000) throw new RangeError('Log pattern input count exceeded');
  for (const value of values) {
    const size = Buffer.byteLength(value);
    if (size > 16384 || (bytes += size) > 16 * 1024 * 1024) throw new RangeError('Log pattern input bytes exceeded');
  }
  if (activeWorkers >= 4) throw new Error('Log pattern worker capacity exceeded');
  activeWorkers++;
  const deadline = performance.now() + 2000;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(source, {eval:true,workerData:{pattern,values},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8}});
    const owned = worker;
    return await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Log pattern execution deadline exceeded')), Math.max(0, deadline - performance.now()));
      owned.once('error', reject);
      owned.once('exit', () => reject(new Error('Log pattern worker exited before a result')));
      owned.once('message', count => {
        if (performance.now() >= deadline) { reject(new Error('Log pattern execution deadline exceeded')); return; }
        if (!Number.isSafeInteger(count) || count < 0 || count > values.length) reject(new Error('Invalid log pattern worker result'));
        else resolve(count);
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    try { if (worker) { await worker.terminate(); worker.removeAllListeners(); } }
    finally { activeWorkers--; }
  }
}
export async function countLogPattern(storage: StorageAdapter, pattern: SerializedLogPattern, from: number, now: number, maximum = 10000): Promise<number> {
  validateLogPattern(pattern);
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new TypeError('Invalid log pattern observation limit');
  const rows = await scanCanonicalLogs(storage, {from: new Date(from), to: new Date(now)});
  if (rows.length > Math.min(maximum, 10000)) throw new RangeError('Log pattern observation limit exceeded');
  return countRegexValues(pattern, rows.flatMap(row => { const message = logField(row, 'message'); return typeof message === 'string' ? [message] : []; }));
}
