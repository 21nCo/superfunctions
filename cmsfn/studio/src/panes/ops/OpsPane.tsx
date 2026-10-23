/** Complete synchronous backup artifact and explicit authorized import. */
import { useEffect, useRef, useState } from 'react';
import { record } from '../audit/useAuditPage.js';
export interface OpsPaneProps { cmsfnApiUrl: string; dataset: string; }
const MAX_BYTES = 25 * 1024 * 1024;
export function OpsPane(props: OpsPaneProps) { return <OpsSession key={JSON.stringify([props.cmsfnApiUrl, props.dataset])} {...props} />; }
function OpsSession({ cmsfnApiUrl, dataset }: OpsPaneProps) {
  const alive = useRef(true), locked = useRef(false);
  const [busy, setBusy] = useState(false), [denied, setDenied] = useState(false);
  const [exportText, setExportText] = useState<string | null>(null), [download, setDownload] = useState<string | null>(null);
  const [artifactText, setArtifactText] = useState(''), [error, setError] = useState<string | null>(null), [imported, setImported] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (exportText === null) { setDownload(null); return; }
    const url = URL.createObjectURL(new Blob([exportText], { type: 'application/json' })); setDownload(url);
    return () => URL.revokeObjectURL(url);
  }, [exportText]);
  async function perform(action: 'export' | 'import') {
    if (locked.current || !dataset) return;
    let artifact: unknown;
    if (action === 'import') {
      if (new TextEncoder().encode(artifactText).byteLength > MAX_BYTES) { setError('Import exceeds the 25 MiB synchronous request limit.'); return; }
      try { artifact = JSON.parse(artifactText); } catch { setError('Invalid artifact JSON.'); return; }
      if (!record(artifact) || artifact.formatVersion !== 1 || typeof artifact.dataset !== 'string') { setError('Invalid import artifact.'); return; }
    }
    const body = JSON.stringify({ dataset, ...(action === 'import' ? { artifact } : {}) });
    if (new TextEncoder().encode(body).byteLength > MAX_BYTES) { setError('Import exceeds the 25 MiB synchronous request limit.'); return; }
    locked.current = true; setBusy(true); setError(null); setImported(false);
    if (action === 'export') setExportText(null);
    try {
      const response = await fetch(`${cmsfnApiUrl.replace(/\/+$/, '')}/cmsfn/ops/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const data: unknown = await response.json(); if (!alive.current) return;
      if (record(data) && data.ok === false && record(data.error)) {
        const code = typeof data.error.code === 'string' && /^[A-Z_]{1,64}$/.test(data.error.code) ? data.error.code : 'REQUEST_FAILED';
        if (code === 'PERMISSION_DENIED') { setDenied(true); setExportText(null); }
        if (code === 'CONTENTFN_UNAVAILABLE' && action === 'import') throw Error('uncertain');
        setError(`Operation failed (${code}).`); return;
      }
      if (!response.ok || !record(data) || data.ok !== true || !record(data.result)) throw Error('invalid response');
      if (action === 'export') {
        const result = data.result.artifact;
        if (!record(result) || result.formatVersion !== 1 || result.dataset !== dataset || !Array.isArray(result.publishedDocs) || !Array.isArray(result.draftDocs) || !Array.isArray(result.assets) || !Array.isArray(result.revisions)) throw Error('invalid artifact');
        setExportText(JSON.stringify(result));
      } else { setImported(true); setArtifactText(''); }
      setDenied(false);
    } catch {
      if (alive.current) setError(action === 'import' ? 'Import could not be confirmed. It may have completed. Inspect dataset state before retrying.' : 'Could not export dataset. Retry the request.');
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  return <div data-ops-pane data-dataset={dataset}>
    <h2>Import / export</h2>
    <p>Target dataset: {dataset}. Imports can overwrite matching documents and schema. Back up the target before importing.</p>
    <p>Cross-dataset migration is denied unless the server explicitly authorizes it. Synchronous request limit: 25 MiB.</p>
    {denied && <p data-ops-denied>No access</p>}
    {error && <p role="alert" data-ops-error>{error}</p>}
    <section><h3>Export</h3>
      <button type="button" disabled={busy || !dataset} onClick={() => void perform('export')} data-ops-export-trigger>Export dataset</button>
      {exportText !== null && <><label>Complete export artifact<textarea readOnly value={exportText} data-ops-export-result rows={8} /></label>{download && <a href={download} download={`${dataset}.export.json`} data-ops-download>Download complete export</a>}</>}
    </section>
    <section><h3>Import</h3>
      <label>Artifact JSON<textarea value={artifactText} onChange={event => setArtifactText(event.target.value)} disabled={busy} data-ops-import-artifact rows={8} /></label>
      <button type="button" disabled={busy || !artifactText.trim() || !dataset} onClick={() => void perform('import')} data-ops-import-trigger>Import to {dataset}</button>
      {imported && <p role="status" data-ops-import-success>Import completed for {dataset}.</p>}
    </section>
    {busy && <p data-ops-working>Working…</p>}
  </div>;
}
