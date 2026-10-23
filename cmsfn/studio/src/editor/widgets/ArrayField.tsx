import { useRef, useState } from 'react';
import type { ContentfnFieldType } from '@contentfn/core';
import { renderField, type RenderFieldOptions } from '../renderField.js';
import { MediaLibraryPane } from '../../panes/media/MediaLibraryPane.js';
import { insertAssetAtPath } from '../../media/insertAssetAtPath.js';
import type { CanonicalAssetRef } from '../../media/insertAssetRef.js';

type ArrayType = Extract<ContentfnFieldType, { kind: 'array' }>;
type Row = { id: number; value: unknown; variant: number | null };
function matches(type: ContentfnFieldType, value: unknown): boolean {
  if (type.kind === 'primitive') return type.type === 'json' || typeof value === (type.type === 'number' ? 'number' : type.type === 'boolean' ? 'boolean' : 'string');
  if (type.kind === 'array' || type.kind === 'richtext') return Array.isArray(value);
  if (type.kind === 'markdown') return typeof value === 'string';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (type.kind === 'reference' || type.kind === 'asset') return '_type' in value && value._type === type.kind;
  return type.kind === 'object';
}
const label = (type: ContentfnFieldType, index: number) => `${index + 1}: ${type.kind === 'primitive' ? type.type : type.kind}`;
function initial(type: ContentfnFieldType): unknown {
  if (type.kind === 'object') return {};
  if (type.kind === 'array' || type.kind === 'richtext') return [];
  if (type.kind === 'primitive') return type.type === 'number' ? 0 : type.type === 'boolean' ? false : type.type === 'json' ? null : '';
  return type.kind === 'markdown' ? '' : null;
}
/** Stable IDs are editor-local, never fields added to a ContentFn array value. */
export function ArrayField({ type, value, onChange, path, required, options }: { type: ArrayType; value: unknown; onChange: (value: unknown) => void; path: string; required: boolean; options?: RenderFieldOptions }) {
  const serial = useRef(0);
  const scope = JSON.stringify([options?.referenceOwnerScope, options?.baseUrl, options?.dataset, options?.fieldSegments ?? path, type]);
  const makeRows = (input: unknown): Row[] => Array.isArray(input) ? input.map(item => {
    const candidates = type.of.map((variant, index) => matches(variant, item) ? index : -1).filter(index => index >= 0);
    return { id: ++serial.current, value: item, variant: type.of.length === 1 ? 0 : candidates.length === 1 ? candidates[0] : null };
  }) : [];
  const [state, setState] = useState(() => ({ source: value, scope, rows: makeRows(value) }));
  const current = useRef(state); current.current = state;
  const currentScope = useRef(scope); currentScope.current = scope;
  const [addVariant, setAddVariant] = useState(0);
  const [picker, setPicker] = useState<{ scope: string; id: number; path: readonly string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (state.source !== value || state.scope !== scope) {
    setState({ source: value, scope, rows: makeRows(value) });
    setPicker(null);
    return null;
  }
  const commit = (rows: Row[]) => {
    if (currentScope.current !== scope) return;
    const nextValue = rows.map(row => row.value);
    const next = { source: nextValue, scope, rows };
    current.current = next; setState(next); onChange(nextValue);
  };
  const change = (id: number, update: (row: Row) => Row) => {
    if (currentScope.current !== scope || current.current.scope !== scope || !current.current.rows.some(row => row.id === id)) return;
    commit(current.current.rows.map(row => row.id === id ? update(row) : row));
  };
  const move = (id: number, direction: number) => {
    const rows = [...current.current.rows]; const from = rows.findIndex(row => row.id === id); const to = from + direction;
    if (from < 0 || to < 0 || to >= rows.length) return;
    [rows[from], rows[to]] = [rows[to], rows[from]]; commit(rows);
  };
  const selectAsset = (asset: CanonicalAssetRef) => {
    if (!picker || picker.scope !== scope || currentScope.current !== scope) return;
    const row = current.current.rows.find(item => item.id === picker.id); if (!row) { setPicker(null); return; }
    try {
      if (picker.path.length > 0 && (row.value !== undefined && (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)))) throw Error('Invalid asset parent');
      const next = picker.path.length === 0 ? asset : insertAssetAtPath(row.value as Record<string, unknown>, picker.path, asset);
      change(row.id, old => ({ ...old, value: next })); setPicker(null); setError(null);
    } catch { setError('Asset field could not be updated.'); }
  };
  return <div data-widget="array" data-field-path={path} data-required={required || undefined}>
    {error && <p role="alert">{error}</p>}
    {value !== undefined && !Array.isArray(value) && <p role="alert">Stored value is not an array. It is preserved until you explicitly edit this field.</p>}
    {state.rows.map((row, index) => <div key={row.id} data-array-item data-array-item-id={row.id}>
      <span>Item {index + 1}</span>
      {type.of.length > 1 && <label>Item type<select aria-label={`Item ${index + 1} type`} value={row.variant ?? ''} onChange={event => {
        const variant = Number(event.target.value); if (!Number.isInteger(variant) || !type.of[variant]) return;
        // Selecting a view does not coerce or persist a new value.
        const next = { ...current.current, rows: current.current.rows.map(item => item.id === row.id ? { ...item, variant } : item) };
        current.current = next; setState(next); if (picker?.id === row.id) setPicker(null);
      }}><option value="" disabled>Choose item type</option>{type.of.map((variant, i) => <option key={i} value={i}>{label(variant, i)}</option>)}</select></label>}
      {row.variant === null ? <p data-array-ambiguous>Select the matching type to edit this item. Its value is unchanged.</p> : renderField({ name: 'item', type: type.of[row.variant] }, `${path}[${index}]`, row.value, next => change(row.id, old => ({ ...old, value: next })), null, {
        ...options, docTypeName: undefined, fieldSegments: [], referenceOwnerScope: `${scope}:${row.id}`,
        onOpenMediaPicker: options?.baseUrl && options.dataset ? (_name, segments) => setPicker({ scope, id: row.id, path: segments }) : undefined,
      })}
      <button type="button" aria-label={`Move item ${index + 1} up`} disabled={index === 0} onClick={() => move(row.id, -1)}>Move up</button>
      <button type="button" aria-label={`Move item ${index + 1} down`} disabled={index === state.rows.length - 1} onClick={() => move(row.id, 1)}>Move down</button>
      <button type="button" aria-label={`Remove item ${index + 1}`} onClick={() => { commit(current.current.rows.filter(item => item.id !== row.id)); if (picker?.id === row.id) setPicker(null); }}>Remove</button>
    </div>)}
    {type.of.length > 1 && <label>New item type<select aria-label="New item type" value={addVariant} onChange={event => setAddVariant(Number(event.target.value))}>{type.of.map((variant, index) => <option key={index} value={index}>{label(variant, index)}</option>)}</select></label>}
    <button type="button" disabled={!type.of[addVariant] || (type.maxLength !== undefined && state.rows.length >= type.maxLength)} onClick={() => { if (!type.of[addVariant] || (type.maxLength !== undefined && current.current.rows.length >= type.maxLength)) return; commit([...current.current.rows, { id: ++serial.current, variant: addVariant, value: initial(type.of[addVariant]) }]); }}>Add item</button>
    {picker?.scope === scope && state.rows.some(row => row.id === picker.id) && options?.baseUrl && options.dataset && <MediaLibraryPane baseUrl={options.baseUrl} dataset={options.dataset} maxUploadBytes={options.maxUploadBytes} onSelectAsset={selectAsset} onClose={() => setPicker(null)} />}
  </div>;
}
