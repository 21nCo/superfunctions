import { describe, expect, it } from 'vitest';
import { chunkMarkdown, resolveChunkingOptions } from '../src/chunking/markdown';

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

  it('returns no chunks for blank input and rejects invalid options', () => {
    expect(chunkMarkdown(' \n\n\t')).toEqual([]);
    expect(() => resolveChunkingOptions({ targetChars: 63 })).toThrow('MEMORY_CHUNKING_INVALID');
    expect(() => resolveChunkingOptions({ targetChars: 100, overlapChars: 51 })).toThrow('MEMORY_CHUNKING_INVALID');
    expect(() => resolveChunkingOptions({ overlapChars: -1 })).toThrow('MEMORY_CHUNKING_INVALID');
    expect(() => resolveChunkingOptions({ targetChars: 1.5e3 + 0.5 })).toThrow('MEMORY_CHUNKING_INVALID');
    expect(resolveChunkingOptions({ targetChars: 100, overlapChars: 50 })).toEqual({ targetChars: 100, overlapChars: 50 });
  });
});
