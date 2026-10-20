import { describe, expect, it } from 'vitest';
import { interpolate, interpolateSync } from './interpolate.js';

describe('literal single-pass expression interpolation', () => {
  const literal = "$&/$`/$'/$$/${{ secrets.TOKEN }}/${{ github.ref }}";
  it('preserves replacement metacharacters and expression-looking secret bytes across repeated references', async () => {
    const names: string[] = [];
    const result = await interpolate('before:${{ secrets.TOKEN }}:middle:${{ secrets.TOKEN }}:after', {
      getSecret: async name => { names.push(name); return literal; },
    });
    expect(result.result).toBe(`before:${literal}:middle:${literal}:after`);
    expect(names).toEqual(['TOKEN', 'TOKEN']);
    expect(result.secretValues).toEqual([literal, literal]);
  });
  it('preserves literal github values in async and synchronous interpolation', async () => {
    const template = '${{ github.ref }} / ${{ github.ref }}';
    const github = { ref: literal };
    expect((await interpolate(template, { github })).result).toBe(`${literal} / ${literal}`);
    expect(interpolateSync(template, { github }).result).toBe(`${literal} / ${literal}`);
    expect((await interpolate('untouched', {})).result).toBe('untouched');
  });
});
