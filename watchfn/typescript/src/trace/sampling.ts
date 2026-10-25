import { createHash } from 'node:crypto';
/** Stable root decision shared with Python; no per-span random resampling. */
export function sampleTrace(traceId: string, rate: number): boolean {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) throw new TypeError('Trace sample rate must be between 0 and 1');
  if (typeof traceId !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(traceId)) throw new TypeError('Trace ID must be valid Unicode');
  return createHash('sha256').update(traceId, 'utf8').digest().readUInt32BE(0) / 4294967296 < rate;
}
