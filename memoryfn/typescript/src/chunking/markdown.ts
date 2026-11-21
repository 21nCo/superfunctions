/** Options for chunkMarkdown. Lengths are UTF-16 code units (JavaScript string length). */
export interface ChunkingOptions {
  /** Most characters in one chunk, overlap included. Default 1,500; at least 64. */
  targetChars?: number;
  /**
   * Characters of the previous chunk repeated at the start of the next chunk of
   * the same section. Default 200; at most half of targetChars. Overlap never
   * crosses a heading.
   */
  overlapChars?: number;
}

export const DEFAULT_CHUNK_TARGET_CHARS = 1_500;
export const DEFAULT_CHUNK_OVERLAP_CHARS = 200;
export const MIN_CHUNK_TARGET_CHARS = 64;

const PARAGRAPH_SEPARATOR = '\n\n';
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SPACES_OR_TABS = /^[ \t]*$/;

/** One piece of a section: a paragraph, or part of a paragraph that was hard split. */
interface Atom { text: string; continues: boolean }
/**
 * A paragraph as it appears in the text, line endings included; `heading`
 * marks a heading line, which starts a new section.
 */
interface Block { text: string; heading: boolean }

/** Validates chunking options and fills in the defaults. */
export function resolveChunkingOptions(options: ChunkingOptions = {}): Required<ChunkingOptions> {
  if (options === null || typeof options !== 'object') throw new Error('MEMORY_CHUNKING_INVALID');
  const targetChars = options.targetChars ?? DEFAULT_CHUNK_TARGET_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS;
  if (!Number.isSafeInteger(targetChars) || targetChars < MIN_CHUNK_TARGET_CHARS
    || !Number.isSafeInteger(overlapChars) || overlapChars < 0 || overlapChars * 2 > targetChars) {
    throw new Error('MEMORY_CHUNKING_INVALID');
  }
  return { targetChars, overlapChars };
}

/**
 * Splits Markdown into chunks: first into sections at ATX headings (`#` to
 * `######`, outside fenced code), then each section into paragraphs at blank
 * lines (a fenced code block is one paragraph of its own), packing whole paragraphs up
 * to targetChars. Only a paragraph longer than targetChars is hard split,
 * preferring the last whitespace in the second half of the window. Each chunk
 * after the first of a section starts with up to overlapChars trailing
 * characters of the previous chunk, fewer when the next paragraph needs the
 * room. No chunk is longer than targetChars or blank, every step is linear in
 * the input, and the output depends only on the input and options.
 */
export function chunkMarkdown(markdown: string, options?: ChunkingOptions): string[] {
  return Array.from(markdownChunks(markdown, options));
}

/**
 * The chunks of chunkMarkdown, produced one at a time, so a caller can stop
 * early (for example at a chunk limit) without splitting the rest. The input
 * and options are validated when it is called, before any chunk is produced.
 */
export function markdownChunks(markdown: string, options?: ChunkingOptions): Generator<string, void, undefined> {
  if (typeof markdown !== 'string') throw new Error('MEMORY_CONTENT_REQUIRED');
  const resolved = resolveChunkingOptions(options);
  return pack(blocks(markdown), resolved.targetChars, resolved.overlapChars);
}

/** Tracks fenced code (CommonMark 4.5) across lines. */
class FenceState {
  private open: string | null = null;
  get inside(): boolean { return this.open !== null; }
  /** Updates the state with `line` and returns 'open' or 'close' when the line opens or closes a fence. */
  next(line: string): 'open' | 'close' | null {
    const match = FENCE.exec(line);
    if (!match) return null;
    const marker = match[1];
    if (this.open === null) {
      // A backtick fence's info string cannot contain a backtick: such a line is inline code, not a fence.
      if (marker[0] === '`' && line.indexOf('`', match[0].length) >= 0) return null;
      this.open = marker;
      return 'open';
    }
    // A closing fence is followed only by spaces or tabs.
    if (marker[0] === this.open[0] && marker.length >= this.open.length && SPACES_OR_TABS.test(line.slice(match[0].length))) {
      this.open = null;
      return 'close';
    }
    return null;
  }
}

/**
 * Paragraphs in document order, split at blank lines, headings and fenced code
 * blocks outside fenced code. Lines end at LF, CRLF or CR, and are read one at
 * a time; a paragraph is one slice of the text, line endings unchanged (pack
 * makes them LF as it reads), so stopping the generator stops the work and
 * the allocation for the rest of the text.
 */
function* blocks(text: string): Generator<Block, void, undefined> {
  const fence = new FenceState();
  const lineEnding = /\r\n?|\n/g;
  // The current paragraph is text[start, end); start < 0 when it is empty.
  let start = -1;
  let end = 0;
  function* flush(heading = false): Generator<Block, void, undefined> {
    // A paragraph never starts with a blank line, so trimming its end keeps indentation; trimEnd is linear.
    const paragraph = start < 0 ? '' : text.slice(start, end).trimEnd();
    start = -1;
    if (paragraph) yield { text: paragraph, heading };
  }
  for (let lineStart = 0; lineStart <= text.length;) {
    lineEnding.lastIndex = lineStart;
    const ending = lineEnding.exec(text);
    const lineEnd = ending ? ending.index : text.length;
    const line = text.slice(lineStart, lineEnd);
    const next = ending ? lineEnding.lastIndex : text.length + 1;
    if (!fence.inside && !line.trim()) {
      yield* flush();
    } else if (!fence.inside && HEADING.test(line)) {
      // A heading is its own paragraph, so it can still be packed with the text after it.
      yield* flush(); start = lineStart; end = lineEnd; yield* flush(true);
    } else {
      const change = fence.next(line);
      // A fenced code block is its own paragraph, even without blank lines around it.
      if (change === 'open') yield* flush();
      if (start < 0) start = lineStart;
      end = lineEnd;
      if (change === 'close') yield* flush();
    }
    lineStart = next;
  }
  yield* flush();
}

/** `text` with CRLF and CR line endings made LF. */
function lf(text: string): string { return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text; }

/**
 * Whether lf(text) has at most `size` characters, decided without building it
 * and reading at most 2 * size characters: each CRLF saves one character, so
 * a text longer than 2 * size never fits.
 */
function lfFits(text: string, size: number): boolean {
  if (text.length <= size) return true;
  if (text.length > 2 * size) return false;
  let length = text.length;
  for (let at = text.indexOf('\r\n'); at >= 0 && length > size; at = text.indexOf('\r\n', at + 2)) length--;
  return length <= size;
}

/**
 * lf(paragraph) as atoms of at most `size` characters; concatenated they give
 * it back. The paragraph is read and its line endings made LF a window at a
 * time, so stopping early leaves the rest of it unread and uncopied.
 */
function* hardSplit(paragraph: string, size: number): Generator<Atom, void, undefined> {
  let read = 0;
  // lf() of what has been read and not yet returned.
  let pending = '';
  let continues = false;
  for (;;) {
    while (pending.length <= size && read < paragraph.length) {
      let end = Math.min(paragraph.length, read + size + 1 - pending.length);
      // A CRLF is never split between windows, so it becomes one LF.
      if (paragraph.charCodeAt(end - 1) === 13 && paragraph.charCodeAt(end) === 10) end++;
      pending += lf(paragraph.slice(read, end));
      read = end;
    }
    if (pending.length <= size) break;
    let end = size;
    const space = lastWhitespace(pending, Math.ceil(size / 2), end);
    if (space >= 0) end = space + 1;
    else if (isHighSurrogate(pending.charCodeAt(end - 1))) end--;
    yield { text: pending.slice(0, end), continues };
    pending = pending.slice(end);
    continues = true;
  }
  yield { text: pending, continues };
}

/** Index of the last whitespace in text[from, end), or -1. */
function lastWhitespace(text: string, from: number, end: number): number {
  for (let index = end - 1; index >= from; index--) if (isWhitespace(text.charCodeAt(index))) return index;
  return -1;
}

function isWhitespace(unit: number): boolean { return /\s/.test(String.fromCharCode(unit)); }
function isHighSurrogate(unit: number): boolean { return unit >= 0xD800 && unit <= 0xDBFF; }

/** The last `count` characters of `text`, starting after a whitespace when there is one, never inside a surrogate pair. */
function overlapTail(text: string, count: number): string {
  if (count <= 0) return '';
  let start = Math.max(0, text.length - count);
  if (start > 0) {
    let space = -1;
    for (let index = start; index < text.length - 1; index++) if (isWhitespace(text.charCodeAt(index))) { space = index; break; }
    if (space >= 0) start = space + 1;
    else if (isHighSurrogate(text.charCodeAt(start - 1))) start++;
  }
  return text.slice(start).trimStart();
}

/**
 * Packs atoms greedily into chunks of at most targetChars. A heading closes the
 * current chunk and the next chunk carries no overlap; any other new chunk
 * starts with up to overlapChars of the previous one, as much as fits beside
 * its first atom.
 */
function* pack(source: Iterable<Block>, targetChars: number, overlapChars: number): Generator<string, void, undefined> {
  let current = '';
  let previous = '';
  for (const block of source) {
    if (block.heading) {
      if (current) yield current;
      current = '';
      previous = '';
    }
    // A paragraph that fits in an empty chunk stays whole; a longer one is split leaving room for the overlap.
    const atoms = lfFits(block.text, targetChars) ? [{ text: lf(block.text), continues: false }] : hardSplit(block.text, targetChars - overlapChars);
    // The first atom emitted from a block follows the paragraph separator, even when a blank atom before it was
    // skipped; a later atom after a skipped blank atom follows one space unless the atom before already ends in
    // whitespace, so the words around it stay apart and no chunk grows needlessly.
    let started = false;
    let skipped = false;
    let endsInSpace = false;
    for (const atom of atoms) {
      if (!atom.text.trim()) { skipped = true; continue; }
      const separator = !atom.continues || !started ? PARAGRAPH_SEPARATOR : skipped && !endsInSpace ? ' ' : '';
      started = true;
      skipped = false;
      endsInSpace = isWhitespace(atom.text.charCodeAt(atom.text.length - 1));
      if (current && current.length + separator.length + atom.text.length > targetChars) {
        yield current;
        previous = current;
        current = '';
      }
      if (!current) {
        const tail = overlapTail(previous, Math.min(overlapChars, targetChars - separator.length - atom.text.length));
        current = tail ? tail + separator + atom.text : atom.text;
      } else {
        current += separator + atom.text;
      }
    }
  }
  if (current) yield current;
}
