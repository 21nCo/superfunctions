import { useRef, useState } from 'react';
import { MediaLibraryPane } from '../../panes/media/MediaLibraryPane.js';
import { MAX_RICHTEXT_BLOCKS } from '../../limits/precheck.js';
export interface RichtextWidgetProps {
  value: unknown; onChange: (value: unknown) => void; required?: boolean; disabled?: boolean;
  'data-field-path'?: string; allowMarks?: string[]; allowObjects?: string[];
  baseUrl?: string; dataset?: string; ownerScope?: string; maxBlocks?: number; maxUploadBytes?: number;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const PAGE = 20;
const key = () => crypto.randomUUID();
function SpanEditor({ block, onChange, disabled, allowMarks }: { block: Record<string, unknown>; onChange: (block: Record<string, unknown>) => void; disabled: boolean; allowMarks?: string[] }) {
  const [page, setPage] = useState(0);
  const children = Array.isArray(block.children) ? block.children : [];
  const effectivePage = Math.min(page, Math.max(0, Math.ceil(children.length / PAGE) - 1));
  const offset = effectivePage * PAGE;
  const marks = allowMarks ?? ['strong', 'em', 'code', 'underline', 'strike-through'];
  const valid = (span: unknown): span is Record<string, unknown> & { _key: string; text: string } => record(span) && span._type === 'span' && typeof span._key === 'string' && !!span._key && children.filter(child => record(child) && child._key === span._key).length === 1 && typeof span.text === 'string';
  const update = (id: string, change: (span: Record<string, unknown>) => Record<string, unknown>) => onChange({ ...block, children: children.map(span => record(span) && span._key === id ? change(span) : span) });
  return <div data-richtext-spans>
    {!Array.isArray(block.children) && <p role="alert">Stored block children are invalid and remain unchanged.</p>}
    {children.slice(offset, offset + PAGE).map((span, i) => valid(span) ? <div key={span._key} data-richtext-span>
      <label>Text {offset + i + 1}<textarea aria-label={`Span ${offset + i + 1} text`} value={span.text} disabled={disabled} onChange={event => update(span._key, old => ({ ...old, text: event.target.value }))} /></label>
      <div>{marks.map(mark => <label key={mark}><input type="checkbox" checked={Array.isArray(span.marks) && span.marks.includes(mark)} disabled={disabled || (span.marks !== undefined && !Array.isArray(span.marks))} onChange={event => update(span._key, old => ({ ...old, marks: event.target.checked ? [...new Set([...(Array.isArray(old.marks) ? old.marks : []), mark])] : (Array.isArray(old.marks) ? old.marks : []).filter(value => value !== mark) }))} />{mark}</label>)}</div>
      <button type="button" disabled={disabled} onClick={() => onChange({ ...block, children: children.filter(child => !record(child) || child._key !== span._key) })}>Remove span {offset + i + 1}</button>
    </div> : <p key={`invalid-${offset + i}`} role="alert">Span {offset + i + 1} is invalid and remains unchanged.</p>)}
    <button type="button" disabled={disabled || !Array.isArray(block.children)} onClick={() => onChange({ ...block, children: [...children, { _type: 'span', _key: key(), text: '', marks: [] }] })}>Add span</button>
    {offset > 0 && <button type="button" onClick={() => setPage(effectivePage - 1)}>Previous spans</button>}
    {offset + PAGE < children.length && <button type="button" onClick={() => setPage(effectivePage + 1)}>Next spans</button>}
  </div>;
}
/** Basic block-array authoring preserves keys, annotations and unknown object fields. */
export function RichtextWidget({ value, onChange, required, disabled = false, 'data-field-path': path, allowMarks, allowObjects, baseUrl, dataset, ownerScope, maxBlocks = MAX_RICHTEXT_BLOCKS, maxUploadBytes }: RichtextWidgetProps) {
  const blocks: unknown[] = Array.isArray(value) ? value : [];
  const scope = JSON.stringify([ownerScope ?? path, baseUrl, dataset, allowMarks, allowObjects, disabled, maxBlocks, maxUploadBytes]);
  const source = useRef({ value, scope, generation: 0 });
  if (source.current.value !== value || source.current.scope !== scope) source.current = { value, scope, generation: source.current.generation + 1 };
  const [page, setPage] = useState(0);
  const [picker, setPicker] = useState<{ scope: string; generation: number } | null>(null);
  const validLimit = Number.isSafeInteger(maxBlocks) && maxBlocks > 0;
  const canAdd = validLimit && blocks.length < maxBlocks && !disabled;
  const effectivePage = Math.min(page, Math.max(0, Math.ceil(blocks.length / PAGE) - 1));
  const offset = effectivePage * PAGE;
  const emit = (next: unknown[]) => { if (disabled || source.current.scope !== scope) return; source.current.value = next; onChange(next); };
  const validKey = (block: unknown): block is Record<string, unknown> & { _key: string } => record(block) && typeof block._key === 'string' && !!block._key && blocks.filter(item => record(item) && item._key === block._key).length === 1;
  const change = (id: string, next: Record<string, unknown>) => { if (source.current.value !== value) return; emit(blocks.map(block => record(block) && block._key === id ? next : block)); };
  const move = (index: number, direction: number) => { if (source.current.value !== value || index + direction < 0 || index + direction >= blocks.length) return; const next = [...blocks]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; emit(next); };
  return <div data-widget="richtext" data-field-path={path} data-required={required || undefined}>
    {(!validLimit || blocks.length > maxBlocks) && <p role="alert">Richtext exceeds the configured block limit. Remove blocks before saving.</p>}
    {value !== undefined && !Array.isArray(value) && <p role="alert">Stored richtext is invalid and remains unchanged until explicitly edited.</p>}
    <p>{blocks.length} blocks</p>
    {blocks.slice(offset, offset + PAGE).map((block, i) => {
      const index = offset + i;
      return <section key={validKey(block) ? block._key : `invalid-${index}`} data-richtext-block>
        <h4>Block {index + 1}</h4>
        {validKey(block) && block._type === 'block' ? <SpanEditor block={block} allowMarks={allowMarks} disabled={disabled} onChange={next => change(block._key, next)} /> : <p data-richtext-object>{record(block) && typeof block._type === 'string' ? block._type : 'Invalid block'}{record(block) && typeof block._ref === 'string' ? `: ${block._ref}` : ''} — preserved</p>}
        {!validKey(block) && <p role="alert">Block requires a unique key. Remove it and add a new block to repair it.</p>}
        <button type="button" disabled={disabled || index === 0} onClick={() => move(index, -1)}>Move block {index + 1} up</button>
        <button type="button" disabled={disabled || index === blocks.length - 1} onClick={() => move(index, 1)}>Move block {index + 1} down</button>
        <button type="button" disabled={disabled} onClick={() => { if (source.current.value === value) emit(blocks.filter((_block, at) => at !== index)); }}>Remove block {index + 1}</button>
      </section>;
    })}
    <button type="button" disabled={!canAdd} onClick={() => { if (canAdd && source.current.value === value) { emit([...blocks, { _type: 'block', _key: key(), children: [{ _type: 'span', _key: key(), text: '', marks: [] }], markDefs: [] }]); setPage(Math.floor(blocks.length / PAGE)); } }}>Add text block</button>
    {allowObjects?.includes('asset') && baseUrl && dataset && <button type="button" disabled={!canAdd} onClick={() => setPicker({ scope, generation: source.current.generation })}>Insert media block</button>}
    {offset > 0 && <button type="button" onClick={() => setPage(effectivePage - 1)}>Previous blocks</button>}
    {offset + PAGE < blocks.length && <button type="button" onClick={() => setPage(effectivePage + 1)}>Next blocks</button>}
    {picker?.scope === scope && picker.generation === source.current.generation && !disabled && baseUrl && dataset && <MediaLibraryPane baseUrl={baseUrl} dataset={dataset} maxUploadBytes={maxUploadBytes} onClose={() => setPicker(null)} onSelectAsset={asset => {
      const latest = source.current;
      const items = latest.value === undefined ? [] : latest.value;
      if (latest.scope !== scope || latest.generation !== picker.generation || !Array.isArray(items) || !validLimit || items.length >= maxBlocks) return;
      emit([...items, { ...asset, _key: key() }]); setPicker(null);
    }} />}
  </div>;
}
