/** Scoped realtime transports: native ContentFn SSE or a host-owned WebSocket. */
const DEFAULT_DEBOUNCE_MS = 500;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
interface Event { type: 'event'; dataset: string; docId?: string }
function connect(realtimeUrl: string | undefined, dataset: string, docId: string | undefined, receive: (event: Event) => void): () => void {
  if (!realtimeUrl || !dataset) return () => {};
  let closed = false; let close = () => {};
  const message = (raw: unknown) => {
    if (closed || typeof raw !== 'string' || raw.length > 1_048_576) return;
    try {
      const value: unknown = JSON.parse(raw);
      if (!record(value) || value.type !== 'event' || value.dataset !== dataset) return;
      const identity = record(value.document) ? value.document._id : value.docId;
      if (docId && (typeof identity !== 'string' || identity.replace(/^drafts\./, '') !== docId.replace(/^drafts\./, ''))) return;
      receive({ type: 'event', dataset, ...(typeof identity === 'string' ? { docId: identity } : {}) });
    } catch { /* Malformed/foreign frames cannot refresh this scope. */ }
  };
  try {
    const url = new URL(realtimeUrl);
    if (url.username || url.password || Array.from(url.searchParams.keys()).some(key => ['token', 'accesstoken', 'authorization', 'cmsfnpreviewtoken', 'apikey', 'auth', 'bearer'].includes(key.toLowerCase().replace(/[_-]/g, '')))) return () => {};
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (typeof EventSource === 'undefined') return () => {};
      url.searchParams.set('dataset', dataset);
      if (docId) url.searchParams.set('docId', docId); else url.searchParams.delete('docId');
      // Native EventSource uses browser cookies; no header or query bearer token.
      const source = new EventSource(url.toString(), { withCredentials: true });
      source.onmessage = event => message(event.data);
      close = () => source.close();
    } else if ((url.protocol === 'ws:' || url.protocol === 'wss:') && typeof WebSocket !== 'undefined') {
      const ws = new WebSocket(url.toString());
      ws.onmessage = event => message(event.data);
      ws.onopen = () => { if (!closed) ws.send(JSON.stringify({ type: 'subscribe', dataset, ...(docId ? { docId } : {}) })); };
      close = () => { try { ws.send(JSON.stringify({ type: 'unsubscribe', dataset, ...(docId ? { docId } : {}) })); } catch { /* Close connecting sockets too. */ } finally { ws.close(); } };
    }
  } catch { /* Unsupported transports fail without leaking credentials. */ }
  return () => { closed = true; try { close(); } catch { /* Cleanup remains idempotent. */ } };
}
export interface SubscribeConfig { realtimeUrl?: string; dataset: string; docId: string; onUpdate: () => void; debounceMs?: number }
export function subscribeToDoc({ realtimeUrl, dataset, docId, onUpdate, debounceMs = DEFAULT_DEBOUNCE_MS }: SubscribeConfig): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = connect(realtimeUrl, dataset, docId, () => { clearTimeout(timer); timer = setTimeout(onUpdate, debounceMs); });
  return () => { clearTimeout(timer); stop(); };
}
export interface SubscribeDatasetConfig { realtimeUrl?: string; dataset: string; onEvent: (event: { type: string; dataset?: string; docId?: string }) => void }
export function subscribeToDataset({ realtimeUrl, dataset, onEvent }: SubscribeDatasetConfig): () => void { return connect(realtimeUrl, dataset, undefined, onEvent); }
