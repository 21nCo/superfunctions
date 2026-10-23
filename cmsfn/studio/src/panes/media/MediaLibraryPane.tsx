/** Dataset-scoped media upload and bounded deterministic pages. */
import { useState, useEffect, useCallback, useRef } from 'react';
import { uploadAssetWithLimit, uploadLimit } from '../../media/upload.js';
import { browseAssets } from '../../media/browse.js';
import { buildAssetRef, type CanonicalAssetRef } from '../../media/insertAssetRef.js';
import type { AssetListItem } from '../../contentfn/client.js';
export interface MediaLibraryPaneProps {
  baseUrl: string; dataset: string; maxUploadBytes?: number;
  onSelectAsset?: (ref: CanonicalAssetRef) => void;
  onClose?: () => void;
}
const PAGE_SIZE = 50;
function fileToBase64(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(Error()); };
    signal.addEventListener('abort', abort, { once: true });
    const done = () => signal.removeEventListener('abort', abort);
    reader.onload = () => { done(); const value = reader.result; if (typeof value !== 'string' || !value.includes(',')) reject(Error()); else resolve(value.slice(value.indexOf(',') + 1)); };
    reader.onerror = () => { done(); reject(Error()); }; reader.onabort = () => { done(); reject(Error()); };
    if (signal.aborted) { done(); reject(Error()); } else reader.readAsDataURL(file);
  });
}
export function MediaLibraryPane({ baseUrl, dataset, maxUploadBytes, onSelectAsset, onClose }: MediaLibraryPaneProps) {
  const scope = JSON.stringify([baseUrl, dataset, maxUploadBytes]); const current = useRef(scope); current.current = scope;
  const generation = useRef(0); const listController = useRef<AbortController>(); const uploadController = useRef<AbortController>();
  const [state, setState] = useState<{ scope: string; assets: AssetListItem[]; offset: number; loading: boolean; error: string | null; denied: boolean }>({ scope, assets: [], offset: 0, loading: true, error: null, denied: false });
  const [upload, setUpload] = useState<{ scope: string; busy: boolean; error: string | null }>({ scope, busy: false, error: null });
  const loadAssets = useCallback(async (offset = 0) => {
    const attempt = ++generation.current; listController.current?.abort(); const controller = new AbortController(); listController.current = controller;
    setState({ scope, assets: [], offset, loading: true, error: null, denied: false });
    const result = await browseAssets({ baseUrl, dataset, limit: PAGE_SIZE, offset, signal: controller.signal });
    if (current.current !== scope || attempt !== generation.current || controller.signal.aborted) return;
    setState(result.ok ? { scope, assets: result.assets, offset, loading: false, error: null, denied: false } : { scope, assets: [], offset, loading: false, error: result.message, denied: result.code === 'PERMISSION_DENIED' });
  }, [baseUrl, dataset, scope]);
  useEffect(() => {
    if (dataset) void loadAssets();
    return () => { ++generation.current; listController.current?.abort(); uploadController.current?.abort(); };
  }, [dataset, loadAssets]);
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file || !dataset) return;
    const limit = uploadLimit(maxUploadBytes);
    if (limit === null || !Number.isSafeInteger(file.size) || file.size > limit || file.size <= 0 || file.name.length > 1024 || file.type.length > 255) { setUpload({ scope, busy: false, error: limit === null ? 'Invalid upload limit.' : 'File exceeds the upload limit or has invalid metadata.' }); return; }
    uploadController.current?.abort(); const controller = new AbortController(); uploadController.current = controller;
    setUpload({ scope, busy: true, error: null });
    try {
      const bytesBase64 = await fileToBase64(file, controller.signal);
      if (controller.signal.aborted || current.current !== scope) return;
      const result = await uploadAssetWithLimit({ baseUrl, maxUploadBytes, signal: controller.signal }, { dataset, filename: file.name, contentType: file.type || 'application/octet-stream', bytesBase64 });
      if (controller.signal.aborted || current.current !== scope) return;
      setUpload({ scope, busy: false, error: result.ok ? null : result.message });
      if (result.ok) await loadAssets();
      else if (result.code === 'PERMISSION_DENIED') { ++generation.current; listController.current?.abort(); setState({ scope, assets: [], offset: 0, loading: false, error: 'No access to media.', denied: true }); }
    } catch { if (current.current === scope && !controller.signal.aborted) setUpload({ scope, busy: false, error: 'File could not be read.' }); }
  };
  const active = state.scope === scope; const loading = !active || state.loading; const assets = active ? state.assets : [];
  const busy = upload.scope === scope && upload.busy; const denied = active && state.denied;
  return <div data-media-library-pane>
    {onClose && <button type="button" onClick={onClose}>Close media library</button>}
    <div data-media-upload><input type="file" data-media-upload-input disabled={busy || !dataset || denied} onChange={handleFileChange} aria-label="Upload file" />
      {upload.scope === scope && upload.error && <p data-media-upload-error role="alert">{upload.error}</p>}</div>
    {active && state.error && <p data-media-browse-error data-media-denied={denied || undefined} role="alert">{state.error}</p>}
    <button type="button" onClick={() => void loadAssets()} disabled={loading || !dataset}>Refresh media</button>
    {loading ? <p data-media-loading>Loading…</p> : <ul data-media-list role="list">{assets.map(asset => <li key={asset.assetId} data-media-item data-asset-id={asset.assetId}><button type="button" data-media-select disabled={!onSelectAsset || denied} onClick={() => { if (current.current === scope) onSelectAsset?.(buildAssetRef(asset.assetId, asset.contentType)); }}><span data-media-filename>{asset.filename}</span><span data-media-id>{asset.assetId}</span></button></li>)}</ul>}
    {active && state.offset > 0 && <button type="button" disabled={loading} onClick={() => void loadAssets(Math.max(0, state.offset - PAGE_SIZE))}>Previous media page</button>}
    {active && assets.length === PAGE_SIZE && <button type="button" disabled={loading} onClick={() => void loadAssets(state.offset + PAGE_SIZE)}>Next media page</button>}
  </div>;
}
