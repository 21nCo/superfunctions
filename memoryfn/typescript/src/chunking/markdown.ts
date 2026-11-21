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

/** One piece of a section: a paragraph, or part of a paragraph that was hard split. */
interface Atom { text: string; continues: boolean }

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
 * lines (a fenced code block stays one paragraph), packing whole paragraphs up
 * to targetChars. A paragraph too long for a chunk is hard split, preferring
 * the last whitespace in the second half of the window. Each chunk after the
 * first of a section starts with up to overlapChars trailing characters of the
 * previous chunk. No chunk is longer than targetChars, and the output depends
 * only on the input and options.
 */
export function chunkMarkdown(markdown: string, options?: ChunkingOptions): string[] {
  if (typeof markdown !== 'string') throw new Error('MEMORY_CONTENT_REQUIRED');
  const { targetChars, overlapChars } = resolveChunkingOptions(options);
  // Room for the overlap and the separator before a paragraph, so every chunk fits one atom.
  const atomChars = targetChars - overlapChars - PARAGRAPH_SEPARATOR.length;
  const chunks: string[] = [];
  for (const section of splitSections(markdown.replace(/\r\n?/g, '\n'))) {
    const atoms = splitParagraphs(section).flatMap(paragraph => hardSplit(paragraph, atomChars));
    chunks.push(...pack(atoms, targetChars, overlapChars));
  }
  return chunks;
}

/** Lines grouped into sections, each starting at a heading (the first may have none). */
function splitSections(text: string): string[][] {
  const sections: string[][] = [[]];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null && HEADING.test(line) && sections[sections.length - 1].length) sections.push([]);
    sections[sections.length - 1].push(line);
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    }
  }
  return sections;
}

/** Paragraphs of a section, split at blank lines outside fenced code. */
function splitParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const paragraph = current.join('\n').replace(/^\n+|\s+$/g, '');
    if (paragraph.trim()) paragraphs.push(paragraph);
    current = [];
  };
  for (const line of lines) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null && !line.trim()) { flush(); continue; }
    // A heading is its own paragraph, so it can still be packed with the text after it.
    if (fence === null && HEADING.test(line)) { flush(); current.push(line); flush(); continue; }
    current.push(line);
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    }
  }
  flush();
  return paragraphs;
}

/** The paragraph as atoms of at most `size` characters; concatenated they give the paragraph back. */
function hardSplit(paragraph: string, size: number): Atom[] {
  const atoms: Atom[] = [];
  let rest = paragraph;
  while (rest.length > size) {
    let end = size;
    const space = lastWhitespace(rest, end);
    if (space >= Math.ceil(size / 2)) end = space + 1;
    else if (isHighSurrogate(rest.charCodeAt(end - 1))) end--;
    atoms.push({ text: rest.slice(0, end), continues: atoms.length > 0 });
    rest = rest.slice(end);
  }
  atoms.push({ text: rest, continues: atoms.length > 0 });
  return atoms;
}

function lastWhitespace(text: string, end: number): number {
  for (let index = end - 1; index >= 0; index--) if (/\s/.test(text[index])) return index;
  return -1;
}

function isHighSurrogate(unit: number): boolean { return unit >= 0xD800 && unit <= 0xDBFF; }

/** The last `count` characters of `text`, starting after a whitespace when there is one, never inside a surrogate pair. */
function overlapTail(text: string, count: number): string {
  if (count <= 0) return '';
  let start = Math.max(0, text.length - count);
  if (start > 0) {
    const space = text.slice(start).search(/\s/);
    if (space >= 0 && start + space + 1 < text.length) start += space + 1;
    else if (isHighSurrogate(text.charCodeAt(start - 1))) start++;
  }
  return text.slice(start).replace(/^\s+/, '');
}

/** Packs a section's atoms greedily into chunks of at most targetChars, with overlap between them. */
function pack(atoms: Atom[], targetChars: number, overlapChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let hasAtom = false;
  for (const atom of atoms) {
    const separator = atom.continues ? '' : PARAGRAPH_SEPARATOR;
    if (hasAtom && current.length + separator.length + atom.text.length > targetChars) {
      chunks.push(current);
      current = overlapTail(current, overlapChars);
      hasAtom = false;
    }
    current = current ? current + separator + atom.text : atom.text;
    hasAtom = true;
  }
  if (hasAtom) chunks.push(current);
  return chunks;
}
