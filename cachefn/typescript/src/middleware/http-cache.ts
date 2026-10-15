/** Shared response-cache policy; framework hooks only translate their native API. */
export type HeaderMap = Record<string, string>;
export interface CachedResponse {
  format: 'cachefn-http-v1';
  status: number;
  headers: HeaderMap;
  body: unknown;
  kind: 'json' | 'text' | 'bytes';
}
export function headers(input: any): HeaderMap {
  const result: HeaderMap = {};
  if (input instanceof Headers) input.forEach((v, k) => { result[k.toLowerCase()] = v; });
  else for (const [k, v] of Object.entries(input ?? {})) if (v !== undefined) result[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return result;
}
export function eligible(method: string, h: HeaderMap): boolean {
  return method === 'GET' && !['authorization', 'cookie', 'range', 'if-range', 'if-none-match', 'if-modified-since'].some(k => k in h)
    && !/(?:^|,)\s*(?:no-cache|no-store|max-age\s*=\s*0)(?:\s|,|$)/i.test(h['cache-control'] ?? '') && !/no-cache/i.test(h.pragma ?? '');
}
export function key(base: string, h: HeaderMap, vary: string[] = []): string {
  const fields = [...new Set(['host', ...vary.map(v => v.toLowerCase())])].sort();
  return 'cachefn:http:' + JSON.stringify([base, fields.map(k => [k, h[k] ?? ''])]);
}
export function snapshot(status: number, input: any, body: unknown, kind: CachedResponse['kind'], vary: string[] = []): CachedResponse | undefined {
  const h = headers(input);
  if (status < 200 || status >= 300 || status === 206 || 'set-cookie' in h || /(?:^|,)\s*(?:private|no-store|no-cache)(?:\s|=|,|$)/i.test(h['cache-control'] ?? '')) return;
  // Origin-managed freshness/age is not replayed beyond its own lifetime.
  if ('expires' in h || 'age' in h || /(?:s-maxage|max-age)\s*=/i.test(h['cache-control'] ?? '')) return;
  const supported = new Set(vary.map(v => v.toLowerCase()));
  if ((h.vary ?? '').split(',').some(v => v.trim() && !supported.has(v.trim().toLowerCase()))) return;
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'date']);
  for (const name of (h.connection ?? '').split(',')) blocked.add(name.trim().toLowerCase());
  for (const name of blocked) delete h[name];
  return { format: 'cachefn-http-v1', status, headers: h, body, kind };
}
export function isResponse(value: any): value is CachedResponse { return value?.format === 'cachefn-http-v1'; }
