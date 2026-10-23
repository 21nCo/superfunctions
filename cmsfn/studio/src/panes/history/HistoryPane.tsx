import { useEffect, useRef, useState } from "react";

const PAGE_SIZE = 20;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
class PageTooLarge extends Error {}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
type Revision = Record<string, unknown> & { _id: string; _type: string; _rev: string; _updatedAt: string };

async function readPage(response: Response): Promise<unknown> {
  if (!response.body) throw Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PAGE_BYTES) throw new PageTooLarge();
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Full immutable snapshots from the authorized ContentFn history endpoint. */
export function HistoryPane({ baseUrl, dataset, docId }: { baseUrl: string; dataset: string; docId: string }) {
  const scope = JSON.stringify([baseUrl, dataset, docId]);
  const activeScope = useRef(scope); activeScope.current = scope;
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<{ scope: string; cursor: string | null; version: number }>({ scope, cursor: null, version: 0 });
  const [state, setState] = useState<{ scope: string; rows: Revision[]; next: string | null; loading: boolean; denied: boolean; error: boolean }>({ scope, rows: [], next: null, loading: false, denied: false, error: false });
  useEffect(() => {
    if (!open) return;
    const cursor = request.scope === scope ? request.cursor : null;
    const token = ++generation.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const current = () => token === generation.current && activeScope.current === scope;
    setState({ scope, rows: [], next: null, loading: true, denied: false, error: false });
    void (async () => {
      try {
        let pageSize = PAGE_SIZE;
        let response: Response;
        let value: unknown;
        // Retry the same cursor without skipping revisions. At most five reads
        // (20,10,5,2,1), sharing the original deadline and cancellation signal.
        while (true) {
          response = await fetch(`${baseUrl.replace(/\/+$/, "")}/contentfn/docs/history`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataset, id: docId, limit: pageSize, cursor }), signal: controller.signal });
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel().catch(() => {});
            if (current()) setState({ scope, rows: [], next: null, loading: false, denied: true, error: false });
            return;
          }
          try { value = await readPage(response); break; }
          catch (error) {
            if (!(error instanceof PageTooLarge) || pageSize === 1 || !current() || controller.signal.aborted) throw error;
            pageSize = Math.max(1, Math.floor(pageSize / 2));
          }
        }
        if (!current()) return;
        if (record(value) && value.ok === false && record(value.error) && value.error.code === "PERMISSION_DENIED") {
          setState({ scope, rows: [], next: null, loading: false, denied: true, error: false }); return;
        }
        if (!response.ok || !record(value) || value.ok !== true || !record(value.result)) throw Error();
        const { revisions, nextCursor } = value.result;
        if (!Array.isArray(revisions) || revisions.length > pageSize || !(nextCursor === null || typeof nextCursor === "string" && nextCursor.length > 0 && nextCursor.length <= 16384 && nextCursor !== cursor)) throw Error();
        const rows: Revision[] = [];
        const keys = new Set<string>();
        for (const revision of revisions) {
          if (!record(revision) || typeof revision._id !== "string" || revision._id.replace(/^drafts\./, "") !== docId.replace(/^drafts\./, "") || typeof revision._type !== "string" || !revision._type || typeof revision._rev !== "string" || !revision._rev || typeof revision._updatedAt !== "string" || !Number.isFinite(Date.parse(revision._updatedAt))) throw Error();
          const key = JSON.stringify([revision._id, revision._rev]); if (keys.has(key)) throw Error(); keys.add(key);
          rows.push({ ...revision, _id: revision._id, _type: revision._type, _rev: revision._rev, _updatedAt: revision._updatedAt });
        }
        setState({ scope, rows, next: nextCursor, loading: false, denied: false, error: false });
      } catch { if (current()) setState({ scope, rows: [], next: null, loading: false, denied: false, error: true }); }
      finally { clearTimeout(timer); }
    })();
    return () => { ++generation.current; controller.abort(); clearTimeout(timer); };
  }, [baseUrl, dataset, docId, scope, open, request]);
  const visible = state.scope === scope ? state : { rows: [], next: null, loading: true, denied: false, error: false };
  return <section data-history-pane>
    <button type="button" aria-expanded={open} onClick={() => { setState({ scope, rows: [], next: null, loading: false, denied: false, error: false }); setOpen(value => !value); setRequest({ scope, cursor: null, version: request.version + 1 }); }}>History</button>
    {open && <div data-history-content>
      <h2>Document history</h2>
      <p>Newest revisions first. Each snapshot includes its draft or published document identity.</p>
      <button type="button" disabled={visible.loading} onClick={() => setRequest({ scope, cursor: null, version: request.version + 1 })}>Refresh history</button>
      {visible.loading && <p>Loading history…</p>}
      {visible.denied && <p role="alert">No access to document history.</p>}
      {visible.error && <p role="alert">Could not load history. Refresh to retry. A single snapshot larger than 2 MiB cannot be displayed.</p>}
      {!visible.loading && !visible.denied && !visible.error && visible.rows.length === 0 && <p>No revisions.</p>}
      <ol>{visible.rows.map(row => <li key={JSON.stringify([row._id, row._rev])} data-history-revision={row._rev}>
        <span>{row._id} — {row._rev} — {row._updatedAt}</span>
        <details><summary>View snapshot</summary><pre>{JSON.stringify(row, null, 2)}</pre></details>
      </li>)}</ol>
      {visible.next && <button type="button" disabled={visible.loading} onClick={() => setRequest({ scope, cursor: visible.next, version: request.version + 1 })}>Older revisions</button>}
    </div>}
  </section>;
}
