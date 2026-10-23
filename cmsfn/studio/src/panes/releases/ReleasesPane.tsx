/** Dataset-scoped release publishing and explicitly configured host scheduling. */
import { useState, useEffect, useRef, useCallback } from "react";
import type { CmsfnRelease, CmsfnReleasePublishResult } from "cmsfn";
import { record } from "../audit/useAuditPage.js";
export interface ReleasesPaneProps { cmsfnApiUrl: string; dataset: string; }
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function release(value: unknown, dataset: string): CmsfnRelease | null {
  if (!record(value) || value.dataset !== dataset || typeof value.releaseId !== "string" || !value.releaseId || typeof value.name !== "string" || !strings(value.docIds) || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || !(value.publishAt === undefined || value.publishAt === null || typeof value.publishAt === "string")) return null;
  let execution: CmsfnRelease['execution'];
  if (value.execution !== undefined) {
    const projected = summary({ ...value.execution, releaseId: value.releaseId }, value.releaseId);
    if (!projected || !record(value.execution) || typeof value.execution.runId !== 'string' || !['running','complete','uncertain','blocked'].includes(String(value.execution.state)) || !strings(value.execution.pending)) return null;
    execution = { runId: value.execution.runId, state: value.execution.state as NonNullable<CmsfnRelease['execution']>['state'], published: projected.published, failures: projected.failures, pending: value.execution.pending };
  }
  return { execution, releaseId: value.releaseId, dataset, name: value.name, docIds: value.docIds, createdAt: value.createdAt, updatedAt: value.updatedAt, publishAt: value.publishAt };
}
function summary(value: unknown, releaseId: string): CmsfnReleasePublishResult | null {
  if (!record(value) || value.releaseId !== releaseId || !strings(value.published) || !Array.isArray(value.failures)) return null;
  const failures: CmsfnReleasePublishResult['failures'] = [];
  for (const item of value.failures) {
    if (!record(item) || typeof item.docId !== 'string' || typeof item.code !== 'string' || typeof item.message !== 'string') return null;
    failures.push({ docId: item.docId, code: item.code, message: item.message });
  }
  let execution: CmsfnReleasePublishResult['execution'];
  if (value.execution !== undefined) {
    if (!record(value.execution) || typeof value.execution.runId !== 'string' || !['running','uncertain','blocked'].includes(String(value.execution.state)) || !strings(value.execution.pending)) return null;
    execution = { runId: value.execution.runId, state: value.execution.state as NonNullable<CmsfnReleasePublishResult['execution']>['state'], pending: value.execution.pending };
  }
  return { releaseId, published: value.published, failures, ...(execution ? { execution } : {}) };
}
/** Remount the session so a previous dataset's pending mutation cannot populate this view. */
export function ReleasesPane(props: ReleasesPaneProps) { return <ReleaseSession key={JSON.stringify([props.cmsfnApiUrl, props.dataset])} {...props} />; }
function ReleaseSession({ cmsfnApiUrl, dataset }: ReleasesPaneProps) {
  const alive = useRef(true); const locked = useRef(false);
  const [releases, setReleases] = useState<CmsfnRelease[]>([]);
  const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false);
  const [denied, setDenied] = useState(false); const [error, setError] = useState<string | null>(null);
  const [publishAt, setPublishAt] = useState(''); const [schedulingEnabled, setSchedulingEnabled] = useState(false);
  const [name, setName] = useState(''); const [docIds, setDocIds] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CmsfnReleasePublishResult | null>(null);
  const request = useCallback(async (action: string, input: Record<string, unknown>) => {
    const response = await fetch(`${cmsfnApiUrl.replace(/\/+$/, '')}/cmsfn/releases/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset, ...input }) });
    const data: unknown = await response.json();
    if (record(data) && data.ok === false && record(data.error)) {
      const code = typeof data.error.code === 'string' && /^[A-Z_]{1,64}$/.test(data.error.code) ? data.error.code : 'REQUEST_FAILED';
      if (code === 'PERMISSION_DENIED' && alive.current) { setDenied(true); setReleases([]); setResult(null); }
      throw new Error(`Request failed (${code}).`);
    }
    if (!response.ok || !record(data) || data.ok !== true || !record(data.result)) throw new Error('Invalid release response');
    return data.result;
  }, [cmsfnApiUrl, dataset]);
  const load = useCallback(async () => {
    const data = await request('list', {});
    if (!Array.isArray(data.releases)) throw new Error('Invalid release list');
    const rows = data.releases.map(item => release(item, dataset));
    if (rows.some(row => row === null)) throw new Error('Invalid release list');
    if (alive.current) { setReleases(rows.filter((row): row is CmsfnRelease => row !== null)); setDenied(false); setSchedulingEnabled(data.schedulingEnabled === true); setReady(true); }
  }, [request, dataset]);
  const run = useCallback(async (operation: () => Promise<void>, mutation = false) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    try { await operation(); }
    catch (failure) { if (alive.current) setError(failure instanceof Error && failure.message.startsWith('Request failed (') ? failure.message : mutation ? 'The operation could not be confirmed. It may have completed. Refresh and check before trying again.' : 'Could not load releases. Refresh to retry.'); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => { alive.current = true; void run(load); return () => { alive.current = false; }; }, [run, load]);
  return <div data-releases-pane data-dataset={dataset}>
    <h2>Releases</h2>
    <p>{schedulingEnabled ? "Scheduled releases publish automatically when processing reaches their scheduled time. Times are selected in your local timezone." : "Manual batch publishing. Scheduling is not configured on this server."}</p>
    {denied && <p data-releases-denied>No access</p>}
    {error && <p role="alert" data-releases-error>{error}</p>}
    <button type="button" disabled={busy} onClick={() => void run(load)} data-releases-refresh>Refresh releases</button>
    {busy && <p data-releases-loading>Working…</p>}
    {!denied && ready && <>
      <form data-releases-create-form onSubmit={event => { event.preventDefault(); if (!name.trim()) return; void run(async () => {
        const created = await request('create', { name: name.trim(), publishAt: schedulingEnabled && publishAt ? new Date(publishAt).toISOString() : null });
        if (typeof created.releaseId !== 'string' || !created.releaseId) throw new Error('Invalid create result');
        if (!alive.current) return; setName(''); setPublishAt(''); await load();
      }, true); }}>
        <label>Release name<input value={name} onChange={event => setName(event.target.value)} data-releases-create-name disabled={busy} /></label>
        {schedulingEnabled && <label>Publish at (local time)<input type="datetime-local" value={publishAt} onChange={event => setPublishAt(event.target.value)} disabled={busy} data-release-publish-at /></label>}
        <button type="submit" disabled={busy || !name.trim()} data-releases-create-submit>Create release</button>
      </form>
      {releases.length === 0 && <p>No releases.</p>}
      <ul data-releases-list>{releases.map(item => <li key={item.releaseId} data-releases-item data-release-id={item.releaseId}>
        <h3 data-releases-item-name>{item.name}</h3><span data-releases-item-doc-count>{item.docIds.length} docs</span>
        {item.publishAt && <p>Scheduled time: {item.publishAt}.</p>}
        {item.execution && <div data-release-execution><p>Execution: {item.execution.state}</p><p>Published: {item.execution.published.length}; failed: {item.execution.failures.length}; pending: {item.execution.pending.length}</p><ul>{item.execution.published.map(id => <li key={id} data-release-execution-published>Published: {id}</li>)}{item.execution.failures.map(failure => <li key={failure.docId} data-release-execution-failed>{failure.docId}: {failure.code} — {failure.message}</li>)}{item.execution.pending.map(id => <li key={id} data-release-execution-waiting>Pending: {id}</li>)}</ul>{item.execution.state === 'uncertain' && <p>A publication outcome is unconfirmed. The host must recover the original run; do not create a replacement run.</p>}</div>}
        <ul>{item.docIds.map(id => <li key={id} data-release-document>{id}</li>)}</ul>
        <form onSubmit={event => { event.preventDefault(); const id = (docIds[item.releaseId] ?? '').trim().replace(/^drafts\./, ''); if (!id) return; void run(async () => {
          await request('add', { releaseId: item.releaseId, docId: id }); if (!alive.current) return;
          setDocIds(old => ({ ...old, [item.releaseId]: '' })); setResult(null); await load();
        }, true); }}>
          <label>Draft document ID<input aria-label={`Draft document ID for ${item.name}`} value={docIds[item.releaseId] ?? ''} onChange={event => setDocIds(old => ({ ...old, [item.releaseId]: event.target.value }))} disabled={busy} data-release-doc-input /></label>
          <button type="submit" disabled={busy || !(docIds[item.releaseId] ?? '').trim().replace(/^drafts\./, '')} data-release-add>Add document</button>
        </form>
        <button type="button" data-releases-publish disabled={busy || item.docIds.length === 0} onClick={() => void run(async () => {
          setResult(null); const published = summary(await request('publish', { releaseId: item.releaseId }), item.releaseId);
          if (!published) throw new Error('Invalid publish result'); if (!alive.current) return; setResult(published); await load();
        }, true)}>Publish release</button>
      </li>)}</ul>
      {result && <section data-releases-publish-result data-release-id={result.releaseId} aria-live="polite">
        {result.execution && <p data-release-execution-pending>Execution {result.execution.state}; {result.execution.pending.length} pending. Publication is not complete.</p>}
        <p>Published: {result.published.length}</p><ul>{result.published.map(id => <li key={id} data-release-published>{id}</li>)}</ul>
        <p data-releases-failures>Failures: {result.failures.length}</p><ul>{result.failures.map(failure => <li key={failure.docId} data-release-failure>{failure.docId}: {failure.code} — {failure.message}</li>)}</ul>
      </section>}
    </>}
  </div>;
}
