import { randomBytes } from 'node:crypto';

export interface TraceContext {
  traceId: string; spanId: string; parentSpanId?: string; traceFlags: number; traceState?: string;
}
type Headers = Record<string, string | string[] | undefined>;
const validId = (value: unknown, length: number): value is string => typeof value === 'string' && value.length === length && new RegExp(`^[0-9a-f]{${length}}$`).test(value) && !/^0+$/.test(value);
function state(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value)) return undefined;
  const members = value.split(',');
  if (members.length > 32) return undefined;
  const seen = new Set<string>();
  for (const raw of members) {
    const member = raw.replace(/^[ \t]+|[ \t]+$/g, '');
    if (!member) continue;
    const split = member.indexOf('=');
    if (split < 1) return undefined;
    const key = member.slice(0, split), data = member.slice(split + 1);
    if (!/^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/.test(key) || seen.has(key) || !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/.test(data)) return undefined;
    seen.add(key);
  }
  return value;
}
/** W3C Trace Context level 1 participant. Header bounds: 512 characters per field. */
export class TraceContextPropagator {
  extract(headers: Headers): TraceContext | null {
    const parents = this.values(headers, 'traceparent');
    if (parents.length !== 1 || parents[0].length > 512) return null;
    const value = parents[0].replace(/^[ \t]+|[ \t]+$/g, '');
    if (/[\r\n]/.test(value)) return null;
    const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-([^\r\n]*))?$/.exec(value);
    if (!match || match[1] === 'ff' || (match[1] === '00' && value.length !== 55) || !validId(match[2], 32) || !validId(match[3], 16)) return null;
    const traceState = state(this.values(headers, 'tracestate').join(','));
    return { traceId: match[2], spanId: match[3], traceFlags: parseInt(match[4], 16) & 1, ...(traceState ? { traceState } : {}) };
  }
  inject(context: TraceContext, headers: Record<string, string> = {}): Record<string, string> {
    this.validate(context);
    for (const key of Object.keys(headers)) if (['traceparent', 'tracestate'].includes(key.toLowerCase())) delete headers[key];
    headers.traceparent = `00-${context.traceId}-${context.spanId}-${(context.traceFlags & 1).toString(16).padStart(2, '0')}`;
    if (context.traceState) headers.tracestate = context.traceState;
    return headers;
  }
  create(parentSpanId?: string): TraceContext {
    if (parentSpanId !== undefined && !validId(parentSpanId, 16)) throw new Error('Invalid trace parent ID');
    return { traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), parentSpanId, traceFlags: 1 };
  }
  createChild(parent: TraceContext): TraceContext {
    this.validate(parent);
    return { traceId: parent.traceId, spanId: randomBytes(8).toString('hex'), parentSpanId: parent.spanId, traceFlags: parent.traceFlags & 1, traceState: parent.traceState };
  }
  private validate(context: TraceContext): void {
    if (!context || !validId(context.traceId, 32) || !validId(context.spanId, 16) || !Number.isInteger(context.traceFlags) || context.traceFlags < 0 || context.traceFlags > 255 || (context.traceState !== undefined && state(context.traceState) === undefined)) throw new Error('Invalid trace context');
  }
  private values(headers: Headers, name: string): string[] {
    if (!headers || typeof headers !== 'object') return [];
    const values: string[] = [];
    let length = 0;
    for (const key in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, key) || key.toLowerCase() !== name) continue;
      const source = headers[key];
      if (source === undefined) continue;
      for (const value of Array.isArray(source) ? source : [source]) {
        if (typeof value !== 'string' || values.length >= (name === 'traceparent' ? 1 : 32)) return [];
        length += value.length + (values.length ? 1 : 0);
        if (length > 512) return [];
        values.push(value);
      }
    }
    return values;
  }
}
export const traceContextPropagator = new TraceContextPropagator();
