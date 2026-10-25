import { createHash } from 'node:crypto';
import { QueryEngine, QueryValidationError } from '../query/query-engine';
import type { QueryOptions } from '../query/types';
import type { StorageAdapter } from '../storage/types';
import { logField, validateIndexFields } from '../storage/log-index/values';

export interface PatternDiscoveryOptions {
  timeRange?: QueryOptions['timeRange'];
  minOccurrences?: number;
  fields?: string[];
}
export type PatternToken = {type:'literal';value:string} | {type:'number'|'uuid'};
export interface DiscoveredLogPattern {
  id: string;
  field: string;
  pattern: string;
  tokens: PatternToken[];
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  samples: string[];
}
const MAX_EVENTS = 10000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_GROUPS = 10000;
const variable = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
const identifier = /[A-Za-z0-9_]/;

/** Deterministic templates, not arbitrary regular-expression inference. */
export function patternTokens(input: string): PatternToken[] {
  if (Buffer.byteLength(input, 'utf8') > 16384 || Buffer.from(input, 'utf8').toString('utf8') !== input) throw new QueryValidationError('Invalid or oversized pattern field');
  const value = input.replace(/[ \t\r\n\f\v]+/g, ' ').replace(/^ +| +$/g, '');
  const tokens: PatternToken[] = [];
  let previous = 0;
  // A new RegExp owns its lastIndex; concurrent discovery calls share no cursor.
  for (const match of value.matchAll(new RegExp(variable.source, 'g'))) {
    const start = match.index!, end = start + match[0].length;
    if ((start > 0 && identifier.test(value[start - 1])) || (end < value.length && identifier.test(value[end]))) continue;
    if (start > previous) tokens.push({type:'literal',value:value.slice(previous,start)});
    tokens.push({type: /^[0-9a-fA-F]{8}-/.test(match[0]) ? 'uuid' : 'number'});
    previous = end;
  }
  if (previous < value.length || !tokens.length) tokens.push({type:'literal',value:value.slice(previous)});
  return tokens;
}
function render(tokens: PatternToken[]): string {
  return tokens.map(token => token.type === 'literal' ? token.value.replace(/\\/g, '\\\\').replace(/</g, '\\<') : `<${token.type}>`).join('');
}
function timestamp(event: Record<string, any>): number | undefined {
  const value = event.timestamp === undefined ? event.ts : event.timestamp;
  const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && Math.abs(time) <= 8640000000000000 ? time : undefined;
}
function compareText(left: string, right: string) {return Buffer.compare(Buffer.from(left),Buffer.from(right));}

export async function discoverLogPatterns(storage: StorageAdapter, input: PatternDiscoveryOptions): Promise<DiscoveredLogPattern[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['timeRange','minOccurrences','fields'].includes(key))) throw new QueryValidationError('Invalid pattern discovery options');
  const min = input.minOccurrences ?? 5;
  if (!Number.isSafeInteger(min) || min < 1 || min > MAX_EVENTS) throw new QueryValidationError('Invalid minimum pattern occurrences');
  const requested = input.fields ?? ['message'];
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 8 || new Set(requested).size !== requested.length) throw new QueryValidationError('Invalid pattern fields');
  const fields = validateIndexFields(requested);
  const bounded: StorageAdapter = {
    add() {throw new Error('Pattern scan is read-only');},
    query() {throw new Error('Pattern scan requires the query engine');},
    async *iterateQuery(options) {
      let count = 0, bytes = 0;
      if (!storage.iterateQuery) throw new QueryValidationError('Pattern discovery requires streaming storage');
      const source = storage.iterateQuery({...options,requireStreaming:true});
      for await (const event of source) {
        if (++count > MAX_EVENTS) throw new QueryValidationError('Pattern scan event limit exceeded');
        const size = Buffer.byteLength(JSON.stringify(event), 'utf8'); bytes += size;
        if (size > 65536 || bytes > MAX_BYTES) throw new QueryValidationError('Pattern scan payload limit exceeded');
        yield event;
      }
    },
  };
  // Reuse the canonical event/type/time semantics; no early result cap can
  // silently lower occurrence counts within the requested window.
  const events = (await new QueryEngine(bounded).execute({where:{type:'log'},timeRange:input.timeRange})).data;
  const groups = new Map<string, DiscoveredLogPattern & {first?:number;last?:number}>();
  for (const event of events) {
    for (const field of fields) {
      const value = logField(event, field);
      if (typeof value !== 'string') continue;
      const tokens = patternTokens(value);
      if (tokens.length === 1 && tokens[0].type === 'literal' && !tokens[0].value) continue;
      const key = JSON.stringify([field,tokens]);
      let group = groups.get(key);
      if (!group) {
        if (groups.size >= MAX_GROUPS) throw new QueryValidationError('Pattern group limit exceeded');
        group = {id:createHash('sha256').update(key).digest('hex'),field,pattern:render(tokens),tokens,count:0,firstSeen:null,lastSeen:null,samples:[]};
        groups.set(key,group);
      }
      group.count++;
      const at = timestamp(event);
      if (at !== undefined) {group.first = Math.min(group.first ?? at,at);group.last = Math.max(group.last ?? at,at);}
      if (!group.samples.includes(value)) {group.samples.push(value);group.samples.sort(compareText);group.samples.length=Math.min(3,group.samples.length);}
    }
  }
  const result = [...groups.values()].filter(group => group.count >= min).sort((a,b) => b.count-a.count || compareText(a.field,b.field) || compareText(a.id,b.id));
  if (result.length > 1000) throw new QueryValidationError('Pattern result limit exceeded');
  return result.map(({first,last,...group}) => ({...group,firstSeen:first===undefined?null:new Date(first).toISOString(),lastSeen:last===undefined?null:new Date(last).toISOString()}));
}
