import type { FeedbackBoardOptions, FeedbackBoardPage, FeedbackItem, FeedbackVote, FeedbackStatus } from '../types';

export interface FeedbackBoardHandle { refresh(): Promise<void>; dispose(): void; }
export interface FeedbackBoardViewOptions extends Omit<FeedbackBoardOptions, 'after'> { title?: string; }
interface BoardService {
  list(options: FeedbackBoardOptions): Promise<FeedbackBoardPage>;
  vote(id: string, direction: -1 | 0 | 1): Promise<FeedbackVote>;
}
const statuses: FeedbackStatus[] = ['open', 'planned', 'in_progress', 'done', 'closed'];

/** Owns only its appended section. Server identity, permissions and vote totals remain authoritative. */
export function mountFeedbackBoard(container: HTMLElement, service: BoardService, options: FeedbackBoardViewOptions = {}, onDispose: () => void = () => {}): FeedbackBoardHandle {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (options.status !== undefined && !statuses.includes(options.status))) throw new TypeError('Invalid feedback board options');
  const doc = container.ownerDocument;
  const root = doc.createElement('section'); root.className = 'userfn-feedback-board';
  root.setAttribute('aria-label', options.title ?? 'Feedback board');
  const heading = doc.createElement('h2'); heading.textContent = options.title ?? 'Feedback board'; root.append(heading);
  const form = doc.createElement('form'); root.append(form);
  const status = doc.createElement('select');
  for (const value of ['', ...statuses]) { const option = doc.createElement('option'); option.value = value; option.textContent = value ? value.replaceAll('_', ' ') : 'All statuses'; status.append(option); }
  status.value = options.status ?? '';
  const tag = doc.createElement('input'); tag.type = 'text'; tag.maxLength = 64; tag.value = options.tag ?? '';
  const area = doc.createElement('input'); area.type = 'text'; area.maxLength = 100; area.value = options.productArea ?? '';
  for (const [name, control] of [['Status', status], ['Tag', tag], ['Product area', area]] as const) {
    const label = doc.createElement('label'); label.append(name, control); form.append(label);
  }
  const apply = doc.createElement('button'); apply.type = 'submit'; apply.textContent = 'Apply filters'; form.append(apply);
  const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh'; form.append(refresh);
  const message = doc.createElement('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); root.append(message);
  const list = doc.createElement('ul'); root.append(list);
  const more = doc.createElement('button'); more.type = 'button'; more.textContent = 'Load more'; more.hidden = true; root.append(more);
  let disposed = false, generation = 0, loading = false, voting = false, uncertain = false;
  let cursor: string | null = null;
  let filters: FeedbackBoardOptions = {};
  const items = new Map<string, FeedbackItem>();
  const cursors = new Set<string>();
  const controls = () => {
    root.setAttribute('aria-busy', String(loading || voting));
    for (const control of [status, tag, area, apply, refresh]) control.disabled = voting;
    more.disabled = loading || voting || uncertain || items.size >= 1000;
    for (const button of list.querySelectorAll<HTMLButtonElement>('button')) button.disabled = loading || voting || uncertain;
  };
  const draw = () => {
    list.replaceChildren();
    for (const item of items.values()) {
      const row = doc.createElement('li'); row.dataset.feedbackId = item.id;
      const title = doc.createElement('h3'); title.textContent = item.title;
      const body = doc.createElement('p'); body.textContent = item.body; body.style.whiteSpace = 'pre-wrap';
      const details = doc.createElement('p'); details.textContent = `${item.status.replaceAll('_', ' ')} · ${item.votes} votes`;
      row.append(title, body, details);
      if (item.tags?.length || item.productArea) { const metadata = doc.createElement('p'); metadata.textContent = [...(item.tags ?? []), ...(item.productArea ? [item.productArea] : [])].join(' · '); row.append(metadata); }
      for (const [direction, label] of [[1, 'Upvote'], [-1, 'Downvote'], [0, 'Remove vote']] as const) {
        const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
        button.setAttribute('aria-label', `${label}: ${item.title}`); button.setAttribute('aria-pressed', String((item.viewerVote ?? 0) === direction));
        button.onclick = () => { void vote(item, direction); }; row.append(button);
      }
      list.append(row);
    }
    more.hidden = cursor === null;
    controls();
  };
  const load = async (append: boolean): Promise<void> => {
    if (disposed || voting || (append && (loading || uncertain || !cursor))) return;
    const token = ++generation;
    if (!append) {
      filters = { limit, ...(status.value ? { status: status.value as FeedbackStatus } : {}), ...(tag.value.trim() ? { tag: tag.value.trim() } : {}), ...(area.value.trim() ? { productArea: area.value.trim() } : {}) };
      items.clear(); cursors.clear(); cursor = null; uncertain = false; draw();
    }
    loading = true; message.textContent = 'Loading feedback…'; controls();
    try {
      const page = await service.list({ ...filters, ...(append && cursor ? { after: cursor } : {}) });
      if (disposed || generation !== token) return;
      if (!page || !Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || cursors.has(page.nextCursor))) || page.items.some(item => !item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.body !== 'string' || !statuses.includes(item.status) || !Number.isSafeInteger(item.votes) || (item.viewerVote !== undefined && ![-1, 0, 1].includes(item.viewerVote)) || (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some(tag => typeof tag !== 'string'))) || (item.productArea != null && typeof item.productArea !== 'string'))) throw new Error('Invalid feedback page');
      if (new Set([...items.keys(), ...page.items.map(item => item.id)]).size > 1000) throw new Error('Board display capacity reached');
      for (const item of page.items) items.set(item.id, { ...item });
      cursor = page.nextCursor; if (cursor) cursors.add(cursor);
      draw(); message.textContent = items.size ? `${items.size} feedback items shown.${items.size >= 1000 && cursor ? ' Narrow the filters to see more.' : ''}` : 'No feedback matches these filters.';
    } catch {
      if (!disposed && generation === token) { uncertain = true; message.textContent = 'Feedback could not be loaded. Check access and refresh to try again.'; }
    } finally { if (!disposed && generation === token) { loading = false; controls(); } }
  };
  const vote = async (item: FeedbackItem, direction: -1 | 0 | 1): Promise<void> => {
    if (disposed || voting || loading || uncertain) return;
    const token = generation; voting = true; message.textContent = 'Saving vote…'; controls();
    try {
      const result = await service.vote(item.id, direction);
      if (disposed || generation !== token) return;
      if (!result || result.id !== item.id || result.viewerVote !== direction || !Number.isSafeInteger(result.votes)) throw new Error('Invalid vote receipt');
      items.set(item.id, { ...item, votes: result.votes, viewerVote: result.viewerVote });
      draw(); message.textContent = 'Vote saved.';
    } catch {
      if (!disposed && generation === token) { uncertain = true; message.textContent = 'Vote not confirmed. Refresh to check its current state before voting again.'; }
    } finally { if (!disposed && generation === token) { voting = false; controls(); if (!uncertain) [...list.children].find(row => (row as HTMLElement).dataset.feedbackId === item.id)?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus(); } }
  };
  form.onsubmit = event => { event.preventDefault(); void load(false); };
  refresh.onclick = () => { void load(false); }; more.onclick = () => { void load(true); };
  container.append(root);
  const handle = { refresh: () => load(false), dispose: () => { if (disposed) return; disposed = true; generation++; root.remove(); items.clear(); onDispose(); } };
  void handle.refresh();
  return handle;
}
