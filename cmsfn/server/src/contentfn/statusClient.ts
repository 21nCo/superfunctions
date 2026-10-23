/** Bounded authenticated ContentFn capability checks; no import-time I/O. */
import type { IncomingMessage } from 'node:http';
import { responseJson, isRecord } from './response.js';
export const BASE_CAPABILITIES = ['content.schema', 'content.docs', 'content.assets'] as const;
export const STATUS_TIMEOUT_MS = 2_000;
export interface ContentfnStatusResult { serverTime: string; capabilities: string[]; }
export interface CapabilityGateConfig {
  /** Installed by the HTTP server; called only after local route authorization. */
  checkCapabilities?: (req: IncomingMessage, required: readonly string[]) => Promise<boolean>;
}
export interface StatusRequestOptions {
  headers?: NonNullable<RequestInit['headers']>;
  required?: readonly string[];
  signal?: AbortSignal;
}
export async function fetchContentfnStatus(baseUrl: string, requireRealtime: boolean, options: StatusRequestOptions = {}): Promise<ContentfnStatusResult | null> {
  try {
    const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/contentfn/status`, { method: 'GET', headers: options.headers, redirect: 'error', signal });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const value: unknown = await responseJson(response, 64 * 1024);
    if (!isRecord(value) || value.ok !== true || !isRecord(value.result)) return null;
    const result = value.result;
    if (typeof result.serverTime !== 'string' || !Number.isFinite(Date.parse(result.serverTime)) || !Array.isArray(result.capabilities) || !result.capabilities.every((item): item is string => typeof item === 'string')) return null;
    const required = options.required ?? [...BASE_CAPABILITIES, ...(requireRealtime ? ['content.realtime'] : [])];
    const capabilities = result.capabilities;
    if (!required.every(capability => capabilities.includes(capability))) return null;
    return { serverTime: result.serverTime, capabilities: result.capabilities };
  } catch { return null; }
}
/** A host credential resolver must not leave readiness pending indefinitely. */
export async function resolveStatusHeaders(provider?: () => NonNullable<RequestInit['headers']> | Promise<NonNullable<RequestInit['headers']>>, signal?: AbortSignal): Promise<NonNullable<RequestInit['headers']> | undefined> {
  if (!provider) return undefined;
  if (signal?.aborted) throw new Error('Status check aborted');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([Promise.resolve().then(provider), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Status identity timed out')), STATUS_TIMEOUT_MS);
      abort = () => reject(new Error('Status check aborted'));
      signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
