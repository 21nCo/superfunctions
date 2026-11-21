import { describe, expect, it, vi } from 'vitest';
import { chunkMarkdown, markdownChunks, resolveChunkingOptions } from '../src/chunking/markdown';

const words = (count: number, word = 'word') => Array.from({ length: count }, (_, index) => `${word}${index}`).join(' ');

describe('chunkMarkdown', () => {
  it('starts a new chunk at every heading, even when sections would fit together', () => {
    const doc = '# Intro\n\nHello there.\n\n## Setup\n\nInstall it.\n\n### Deep\nNested text.';
    expect(chunkMarkdown(doc)).toEqual(['# Intro\n\nHello there.', '## Setup\n\nInstall it.', '### Deep\n\nNested text.']);
  });

  it('keeps text before the first heading as its own chunk and ignores headings inside fenced code', () => {
    const doc = 'Preamble.\n\n# Title\n\n```md\n# not a heading\n\nstill code\n```\n\nAfter.';
    expect(chunkMarkdown(doc)).toEqual(['Preamble.', '# Title\n\n```md\n# not a heading\n\nstill code\n```\n\nAfter.']);
  });

  it('packs whole paragraphs up to the target and overlaps chunks of the same section only', () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => words(8, `p${index}w`));
    const doc = `# A\n\n${paragraphs.join('\n\n')}\n\n# B\n\nshort`;
    const chunks = chunkMarkdown(doc, { targetChars: 120, overlapChars: 20 });
    expect(chunks.every(chunk => chunk.length <= 120)).toBe(true);
    const sectionA = chunks.slice(0, -1);
    expect(sectionA.length).toBeGreaterThan(1);
    for (let index = 1; index < sectionA.length; index++) {
      const tail = sectionA[index - 1].slice(-20);
      // The next chunk starts with a word-aligned piece of the previous chunk's last 20 characters.
      const overlap = sectionA[index].split('\n\n')[0];
      expect(overlap.length).toBeGreaterThan(0);
      expect(overlap.length).toBeLessThanOrEqual(20);
      expect(tail.endsWith(overlap)).toBe(true);
    }
    // Every paragraph appears whole in some chunk; none is split when it fits.
    for (const paragraph of paragraphs) expect(chunks.some(chunk => chunk.includes(paragraph))).toBe(true);
    // No overlap is carried across the heading.
    expect(chunks[chunks.length - 1]).toBe('# B\n\nshort');
  });

  it('hard splits an oversize paragraph at whitespace, and concatenating the pieces gives it back', () => {
    const paragraph = words(200);
    const chunks = chunkMarkdown(paragraph, { targetChars: 100, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every(chunk => chunk.length <= 100)).toBe(true);
    expect(chunks.join('')).toBe(paragraph);
    expect(chunks.slice(0, -1).every(chunk => chunk.endsWith(' '))).toBe(true);
  });

  it('hard splits text without whitespace at the limit and never inside a surrogate pair', () => {
    const emoji = '\u{1F600}'.repeat(100);
    const chunks = chunkMarkdown(emoji, { targetChars: 64, overlapChars: 10 });
    expect(chunks.every(chunk => chunk.length <= 64)).toBe(true);
    for (const chunk of chunks) expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    expect(chunks.join('')).toContain(emoji.slice(0, 40));
  });

  it('applies the defaults of 1,500 characters and 200 characters of overlap', () => {
    const chunks = chunkMarkdown(words(1_000));
    expect(chunks.every(chunk => chunk.length <= 1_500)).toBe(true);
    expect(Math.max(...chunks.map(chunk => chunk.length))).toBeGreaterThan(1_200);
    // About 200 characters (word aligned) of the previous chunk lead the next one.
    const window = chunks[0].slice(-200);
    const start = window.indexOf(chunks[1].slice(0, 20));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(chunks[1].startsWith(window.slice(start))).toBe(true);
    expect(window.length - start).toBeGreaterThan(180);
  });

  it('is deterministic and normalizes line endings', () => {
    const doc = `# T\r\n\r\n${words(300)}\r\n\r\n## U\r\n${words(50)}`;
    const first = chunkMarkdown(doc, { targetChars: 200, overlapChars: 40 });
    expect(chunkMarkdown(doc, { targetChars: 200, overlapChars: 40 })).toEqual(first);
    expect(chunkMarkdown(doc.replace(/\r\n/g, '\n'), { targetChars: 200, overlapChars: 40 })).toEqual(first);
    expect(first.some(chunk => chunk.includes('\r'))).toBe(false);
  });

  it('reads CR line endings like LF', () => {
    const doc = `# T\r\r${words(300)}\r\r## U\r${words(50)}\r\r\`\`\`\rcode\r\`\`\``;
    expect(chunkMarkdown(doc, { targetChars: 200, overlapChars: 40 })).toEqual(chunkMarkdown(doc.replace(/\r/g, '\n'), { targetChars: 200, overlapChars: 40 }));
  });

  it.each([['CRLF', '\r\n'], ['CR', '\r']])('normalizes %s line endings as it reads, without copying the unread text', (_name, ending) => {
    const text = `# Title${ending}${ending}${words(8)}${ending}`.repeat(400_000);
    text.indexOf('\0'); // flattens the repeated string before measuring
    const before = process.memoryUsage().heapUsed;
    const chunks = markdownChunks(text);
    expect(chunks.next().value).toBe(`# Title\n\n${words(8)}`);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(text.length / 4);
  });

  it('hard splits an oversized CRLF fenced block as it reads, without copying the rest of the block', () => {
    const text = `\`\`\`\r\n${`${'x'.repeat(30)}\r\n`.repeat(750_000)}\`\`\``;
    text.indexOf('\0'); // flattens the repeated string before measuring
    const before = process.memoryUsage().heapUsed;
    const chunks = markdownChunks(text, { targetChars: 64, overlapChars: 32 });
    const [expected] = chunkMarkdown(`\`\`\`\n${`${'x'.repeat(30)}\n`.repeat(10)}\`\`\``, { targetChars: 64, overlapChars: 32 });
    expect(chunks.next().value).toBe(expected);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(text.length / 4);
  });

  it('hard splits CRLF and CR paragraphs exactly like LF ones', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index} ${'w'.repeat(index % 17)}`);
    const fenced = `\`\`\`\n${lines.join('\n')}\n\`\`\``;
    const expected = chunkMarkdown(`# T\n\n${fenced}`, { targetChars: 100, overlapChars: 30 });
    expect(chunkMarkdown(`# T\r\n\r\n${fenced.replace(/\n/g, '\r\n')}`, { targetChars: 100, overlapChars: 30 })).toEqual(expected);
    expect(chunkMarkdown(`# T\r\r${fenced.replace(/\n/g, '\r')}`, { targetChars: 100, overlapChars: 30 })).toEqual(expected);
  });

  it('keeps a paragraph that fits a fresh chunk whole, shortening the overlap to make room', () => {
    const first = 'aaaa bbb';
    const second = `${'abcd '.repeat(10)}efghi`;
    expect(second).toHaveLength(55);
    const chunks = chunkMarkdown(`${first}\n\n${second}`, { targetChars: 64, overlapChars: 10 });
    // The old chunker hard split the second paragraph across both chunks.
    expect(chunks).toEqual([first, `bbb\n\n${second}`]);
    expect(chunkMarkdown(`${first}\n\n${'z'.repeat(64)}`, { targetChars: 64, overlapChars: 10 })).toEqual([first, 'z'.repeat(64)]);
  });

  it('does not open a fence at a backtick line whose info string contains a backtick', () => {
    const doc = '```inline`code```\n\n# Next\n\nText.\n\n~~~ a`b\n# fenced\n~~~\n\n# Last';
    expect(chunkMarkdown(doc)).toEqual(['```inline`code```', '# Next\n\nText.\n\n~~~ a`b\n# fenced\n~~~', '# Last']);
  });

  it('splits a long whitespace run in linear time without blank chunks and keeps indentation', () => {
    const doc = `  indented start${' '.repeat(1_000_000)}end\n\n    code line`;
    const started = performance.now();
    const chunks = chunkMarkdown(doc, { targetChars: 64, overlapChars: 16 });
    // The old trailing-whitespace regex took minutes on a run this long.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(chunks[0].startsWith('  indented start')).toBe(true);
    // The indented paragraph after the run keeps its indentation.
    expect(chunks[chunks.length - 1].endsWith('end\n\n    code line')).toBe(true);
    expect(chunks.every(chunk => chunk.trim() !== '' && chunk.length <= 64)).toBe(true);
  });

  it('produces chunks lazily, so a caller can stop without splitting the rest', () => {
    const iterator = markdownChunks('x '.repeat(2_100_000), { targetChars: 64, overlapChars: 32 });
    const first = [iterator.next().value, iterator.next().value];
    expect(first.every(chunk => typeof chunk === 'string' && chunk.length <= 64)).toBe(true);
    expect(() => markdownChunks('x', { targetChars: 1 })).toThrow('MEMORY_CHUNKING_INVALID');
  });

  it('reads lines one at a time, so stopping early leaves the rest of the text unsplit', () => {
    const doc = Array.from({ length: 200_000 }, (_, index) => `para ${index}`).join('\n\n');
    const split = vi.spyOn(String.prototype, 'split');
    try {
      const first = markdownChunks(doc, { targetChars: 64, overlapChars: 0 }).next().value;
      expect(first).toBe(Array.from({ length: 8 }, (_, index) => `para ${index}`).join('\n\n'));
      expect(split).not.toHaveBeenCalled();
    } finally {
      split.mockRestore();
    }
  });

  it('keeps a fitting fenced block whole when prose touches it without blank lines', () => {
    const before = 'p'.repeat(48);
    const after = 'q'.repeat(48);
    const fence = '```js\nconst a = 1;\n```';
    expect(chunkMarkdown(`${before}\n${fence}\n${after}`, { targetChars: 64, overlapChars: 0 })).toEqual([before, fence, after]);
  });

  it('closes a fence only at a marker followed by nothing but spaces or tabs', () => {
    const doc = '```\n# inside\n```\u00a0\n# still inside\n``` \t\n\n# After';
    expect(chunkMarkdown(doc)).toEqual(['```\n# inside\n```\u00a0\n# still inside\n```', '# After']);
  });

  it('returns no chunks for blank input and rejects invalid options', () => {
    expect(chunkMarkdown(' \n\n\t')).toEqual([]);
    expect(() => resolveChunkingOptions({ targetChars: 63 })).toThrow('MEMORY_CHUNKING_INVALID');
    expect(() => resolveChunkingOptions({ targetChars: 100, overlapChars: 51 })).toThrow('MEMORY_CHUNKING_INVALID');
    expect(() => resolveChunkingOptions({ overlapChars: -1 })).toThrow('MEMORY_CHUNKING_INVALID');
    expect(() => resolveChunkingOptions({ targetChars: 1.5e3 + 0.5 })).toThrow('MEMORY_CHUNKING_INVALID');
    expect(resolveChunkingOptions({ targetChars: 100, overlapChars: 50 })).toEqual({ targetChars: 100, overlapChars: 50 });
  });
});

describe('hard split paragraph separator', () => {
  it('keeps the separator before the first emitted atom when a blank atom before it is skipped', () => {
    const doc = `intro\n\n${' '.repeat(64)}code`;
    expect(chunkMarkdown(doc, { targetChars: 64, overlapChars: 0 })).toEqual(['intro\n\ncode']);
  });

  it('still joins later atoms of one paragraph without a separator, overlaps, and stays within the target', () => {
    const doc = `intro\n\n${' '.repeat(64)}${words(30)}`;
    for (const overlapChars of [0, 16]) {
      const chunks = chunkMarkdown(doc, { targetChars: 64, overlapChars });
      // Without overlap the second paragraph's first words do not fit beside intro; with it they follow its separator.
      expect(chunks[0]).toMatch(overlapChars ? /^intro\n\n {16}word0 / : /^intro$/);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(64);
      expect(chunks.join(' ')).not.toMatch(/intro\S|word\d+word/);
      expect(chunks.filter(chunk => !chunk.trim())).toEqual([]);
      expect(chunks.join(' ')).toContain('word29');
    }
  });

  it.each([[0, 64], [16, 48]])('keeps words apart around a skipped blank atom inside a paragraph (overlap %i)', (overlapChars, size) => {
    const chunks = chunkMarkdown(`${'x'.repeat(size)}${' '.repeat(size)}bar`, { targetChars: 64, overlapChars });
    expect(chunks.join('|')).not.toMatch(/xbar/);
    expect(chunks.join(' ')).toMatch(/x bar/);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(64);
  });

  it('adds no space after a skipped blank atom when the atom before already ends in whitespace', () => {
    // Atoms: 47 x and a space, 48 spaces (skipped), 16 b: 48 + 16 fits the 64-character target exactly.
    const chunks = chunkMarkdown(`${'x'.repeat(47)}${' '.repeat(49)}${'b'.repeat(16)}`, { targetChars: 64, overlapChars: 16 });
    expect(chunks).toEqual([`${'x'.repeat(47)} ${'b'.repeat(16)}`]);
  });
});
