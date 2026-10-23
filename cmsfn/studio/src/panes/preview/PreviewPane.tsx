import { useState, useEffect, useRef, useCallback } from 'react';
import { previewAudience, previewDocumentId } from 'cmsfn';
import { subscribeToDoc } from '../../realtime/subscribe.js';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export interface PreviewPaneProps {
  previewEnabled?: boolean;
  targetOrigin: string;
  resolveUrl: (doc: unknown) => string;
  cmsfnApiUrl?: string;
  dataset: string;
  doc: unknown;
  /** HTTP(S) ContentFn events endpoint or a host-provided WebSocket transport. */
  realtimeUrl?: string;
  refreshTrigger?: number;
}
async function readTokenResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw Error(); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > 256 * 1024) throw Error(); chunks.push(item.value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
}
export function PreviewPane({ previewEnabled, targetOrigin, resolveUrl, cmsfnApiUrl, dataset, doc, realtimeUrl, refreshTrigger }: PreviewPaneProps) {
  const eventDocId = record(doc) && typeof doc._id === 'string' ? doc._id : undefined;
  const docId = previewDocumentId(eventDocId);
  const audience = previewAudience(targetOrigin);
  let destination: string | null = null;
  try {
    const url = new URL(previewEnabled && docId ? resolveUrl(doc) : "");
    if (audience && previewAudience(url.toString()) === audience && !url.username && !url.password) destination = url.toString();
  } catch { /* Invalid resolver output must never receive a token. */ }
  const scope = JSON.stringify([previewEnabled, cmsfnApiUrl, dataset, docId, eventDocId, audience, destination]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const generation = useRef(0);
  const [state, setState] = useState<{ scope: string; token: string | null; expires: number; error: boolean }>({ scope, token: null, expires: 0, error: false });
  const [retry, setRetry] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey(value => value + 1), []);
  useEffect(() => {
    if (!previewEnabled || !cmsfnApiUrl || !docId || !dataset || !audience || !destination) return;
    const scopedDocId = docId;
    const tokenGeneration = ++generation.current; const controller = new AbortController();
    let renew: ReturnType<typeof setTimeout> | undefined, expire: ReturnType<typeof setTimeout> | undefined;
    const current = () => tokenGeneration === generation.current && currentScope.current === scope;
    const active = () => current() && !controller.signal.aborted;
    setState({ scope, token: null, expires: 0, error: false });
    async function requestToken() {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const operation = async () => {
          const response = await fetch(`${cmsfnApiUrl!.replace(/\/+$/, '')}/cmsfn/preview/token`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset, docId }), signal: controller.signal });
          return readTokenResponse(response);
        };
        const value = await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => { controller.abort(); reject(new Error('Preview request timed out')); }, 10_000);
        })]);
        if (!record(value) || value.ok !== true || !record(value.result)) throw Error();
        const result = value.result, expires = typeof result.expiresAt === 'string' ? Date.parse(result.expiresAt) : NaN;
        if (typeof result.token !== 'string' || !result.token || result.token.length > 128 * 1024 || result.dataset !== dataset || result.audience !== audience || !Array.isArray(result.docIds) || !result.docIds.every(id => typeof id === 'string') || !result.docIds.includes(scopedDocId) || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 901_000) throw Error();
        if (!active()) return;
        clearTimeout(expire); clearTimeout(renew);
        setState({ scope, token: result.token, expires, error: false });
        expire = setTimeout(() => { if (current()) setState({ scope, token: null, expires: 0, error: true }); }, expires - Date.now());
        renew = setTimeout(() => { void requestToken(); }, Math.max(100, (expires - Date.now()) * 0.75));
      } catch {
        if (tokenGeneration === generation.current && currentScope.current === scope) setState({ scope, token: null, expires: 0, error: true });
      } finally { clearTimeout(deadline); }
    }
    void requestToken();
    return () => { ++generation.current; controller.abort(); clearTimeout(renew); clearTimeout(expire); };
  }, [previewEnabled, cmsfnApiUrl, dataset, docId, audience, destination, scope, retry]);
  useEffect(() => {
    if (!previewEnabled || !eventDocId || !realtimeUrl || !destination) return;
    return subscribeToDoc({ realtimeUrl, dataset, docId: eventDocId, onUpdate: refresh });
  }, [previewEnabled, realtimeUrl, dataset, eventDocId, destination, refresh]);
  const previousTrigger = useRef(refreshTrigger);
  useEffect(() => { if (refreshTrigger != null && refreshTrigger !== previousTrigger.current) { previousTrigger.current = refreshTrigger; refresh(); } }, [refreshTrigger, refresh]);
  if (!previewEnabled) return <div data-preview-pane data-preview-disabled="true"><p>Preview is not configured.</p></div>;
  if (!cmsfnApiUrl || !docId) return <div data-preview-pane data-preview-disabled="true"><p>Preview requires CmsFn server URL and an open document.</p></div>;
  if (!audience || !destination) return <div data-preview-pane data-preview-error="true"><p>Preview URL must match the configured HTTP(S) origin and contain no credentials.</p></div>;
  const visible = state.scope === scope && state.expires > Date.now() ? state.token : null;
  if (!visible) return <div data-preview-pane data-preview-error="true"><p>{state.scope === scope && state.error ? 'Failed to load a valid preview token.' : 'Loading preview…'}</p>{state.scope === scope && state.error && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry preview</button>}</div>;
  const url = new URL(destination); url.searchParams.set('cmsfn_preview_token', visible);
  return <div data-preview-pane data-preview-visible="true"><iframe key={`${scope}:${refreshKey}:${visible}`} data-preview-iframe title="Preview" src={url.toString()} referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', border: 'none' }} /></div>;
}
