/** Scoped deterministic reference pages and bounded labels. */
import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { CmsfnReferenceCandidate } from 'cmsfn';
import { queryCandidates } from '../../../references/queryCandidates.js';
export interface ReferencePickerDialogProps {
  baseUrl: string; cmsfnApiUrl?: string; dataset: string; allowedTypes: string[];
  allowContentfnAuthorization?: boolean; hasDocRead?: boolean;
  onSelect: (ref: { _type: 'reference'; _ref: string }) => void; onClose: () => void;
}
export function ReferencePickerDialog({ baseUrl, cmsfnApiUrl, dataset, allowedTypes, allowContentfnAuthorization = false, hasDocRead = true, onSelect, onClose }: ReferencePickerDialogProps) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  const allowedKey = JSON.stringify([...new Set(allowedTypes)].sort());
  const baseScope = JSON.stringify([baseUrl, cmsfnApiUrl, dataset, allowedKey, allowContentfnAuthorization, hasDocRead]);
  const [typeFilter, setTypeFilter] = useState({ scope: baseScope, type: '' });
  const selectedType = typeFilter.scope === baseScope && allowedTypes.includes(typeFilter.type) ? typeFilter.type : '';
  const typesKey = JSON.stringify(selectedType ? [selectedType] : [...new Set(allowedTypes)].sort());
  const scope = JSON.stringify([baseScope, selectedType]);
  const current = useRef(scope); current.current = scope;
  const [search, setSearch] = useState({ scope, text: '' });
  const [filter, setFilter] = useState({ scope, text: '' });
  const activeFilter = filter.scope === scope ? filter.text : '';
  const requestScope = JSON.stringify([scope, activeFilter]); const currentRequest = useRef(requestScope); currentRequest.current = requestScope;
  const generation = useRef(0); const controller = useRef<AbortController>();
  const [state, setState] = useState<{ scope: string; data: CmsfnReferenceCandidate[]; next: string | null; loading: boolean; denied: boolean; error: string | null }>({ scope: requestScope, data: [], next: null, loading: true, denied: false, error: null });
  const load = useCallback(async (cursor: string | null = null) => {
    const attempt = ++generation.current; controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setState({ scope: requestScope, data: [], next: null, loading: true, denied: false, error: null });
    if (!hasDocRead) { setState({ scope: requestScope, data: [], next: null, loading: false, denied: true, error: 'No access' }); return; }
    const result = await queryCandidates({ baseUrl, cmsfnApiUrl, dataset, types: selectedType ? [selectedType] : [...new Set(allowedTypes)].sort(), allowContentfnAuthorization, search: activeFilter, cursor, limit: 20, signal: abort.signal });
    if (abort.signal.aborted || attempt !== generation.current || currentRequest.current !== requestScope) return;
    setState(result.ok ? { scope: requestScope, data: result.result.data, next: result.result.nextCursor, loading: false, denied: false, error: null } : { scope: requestScope, data: [], next: null, loading: false, denied: result.error.code === 'PERMISSION_DENIED', error: result.error.message });
  }, [baseUrl, cmsfnApiUrl, dataset, typesKey, selectedType, allowContentfnAuthorization, hasDocRead, activeFilter, requestScope]);
  useEffect(() => { void load(); return () => { ++generation.current; controller.current?.abort(); }; }, [load]);
  const active = state.scope === requestScope; const loading = !active || state.loading;
  const denied = !hasDocRead || (active && state.denied);
  const dialog = <div ref={dialogRef} role="dialog" aria-label="Choose reference" aria-modal="true" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); } }} data-ref-picker data-ref-picker-denied={denied || undefined}>
    <h2>Choose reference</h2><button type="button" onClick={onClose} data-ref-picker-close>Close</button>
    {allowedTypes.length > 1 && <label>Reference type<select aria-label="Reference type" value={selectedType} onChange={event => setTypeFilter({ scope: baseScope, type: event.target.value })}><option value="">All field types</option>{[...new Set(allowedTypes)].sort().map(type => <option key={type} value={type}>{type}</option>)}</select></label>}
    <label>Filter references<input aria-label="Filter references" maxLength={128} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (!loading && !denied) setFilter({ scope, text: search.scope === scope ? search.text.trim() : '' }); } }} value={search.scope === scope ? search.text : ''} onChange={event => setSearch({ scope, text: event.target.value })} /></label>
    <button type="button" disabled={loading || denied} onClick={() => setFilter({ scope, text: search.scope === scope ? search.text.trim() : '' })}>Apply reference filter</button>
    <p>Filter matches case-sensitive text in ID, title or name.</p>
    <button type="button" disabled={loading} onClick={() => void load()}>Refresh references</button>
    {denied ? <p data-ref-picker-denied-message>No access</p> : active && state.error ? <p data-ref-picker-error role="alert">{state.error}</p> : null}
    {loading && <p data-ref-picker-loading>Loading…</p>}
    <ul data-ref-picker-list>{active && !loading && !denied && state.data.map(candidate => <li key={candidate._id} data-ref-picker-item data-ref-picker-item-id={candidate._id}><button type="button" data-ref-picker-select onClick={() => { if (current.current === scope && currentRequest.current === requestScope) { onSelect({ _type: 'reference', _ref: candidate._id }); onClose(); } }}>{candidate.label || candidate._id.slice(0, 160)} <small>{candidate._type}</small></button></li>)}</ul>
    {active && !denied && state.next && <button type="button" data-ref-picker-load-more disabled={loading} onClick={() => void load(state.next)}>Load more</button>}
  </div>;
  return typeof document === 'undefined' ? null : createPortal(dialog, document.body);
}
