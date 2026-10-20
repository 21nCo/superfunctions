import { describe, expect, it } from 'vitest';
import { createLineProcessor } from '../src/process-events.js';

describe('process output ownership', () => {
  it('drains concurrent pushes in order, including UTF-8 split across chunks', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lines: string[] = [];
    const processor = createLineProcessor('stderr', async line => {
      if (line === 'first') await gate;
      lines.push(line);
    });
    const text = Buffer.from('first\n😀 final');
    const pushes = [processor.push(text.subarray(0, 8)), processor.push(text.subarray(8))];
    const flushed = processor.flush();
    await Promise.resolve();
    expect(lines).toEqual([]);
    release();
    await Promise.all([...pushes, flushed]);
    expect(lines).toEqual(['first', '😀 final']);
    await processor.flush();
    expect(lines).toHaveLength(2);
  });
  it('reports sink failures through both admission and flush', async () => {
    const processor = createLineProcessor('stdout', async () => { throw new Error('disk failed'); });
    await expect(processor.push('message\n')).rejects.toThrow('disk failed');
    await expect(processor.flush()).rejects.toThrow('disk failed');
  });
});
