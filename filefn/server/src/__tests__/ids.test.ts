import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateFileFnId, type FileFnIdPrefix } from '../ids.js';

const PREFIXES: FileFnIdPrefix[] = ['upl', 'file', 'ver', 'art'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateFileFnId', () => {
  it.each(PREFIXES)('formats %s IDs as <prefix>_<20 base32 chars>, below the log redaction length', (prefix) => {
    const id = generateFileFnId(prefix);

    expect(id).toMatch(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{20}$`));
    // The log redactor masks any 32+ char [A-Za-z0-9_-] run as a secret.
    expect(id.length).toBeLessThan(32);
  });

  it.each(PREFIXES)('generates no duplicate %s IDs over 10,000 generations', (prefix) => {
    const ids = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      ids.add(generateFileFnId(prefix));
    }

    expect(ids.size).toBe(10_000);
  });

  it('draws from crypto.getRandomValues, not Math.random', () => {
    const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const mathRandom = vi.spyOn(Math, 'random');

    generateFileFnId('file');

    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it('maps every random byte onto the alphabet, so each symbol is reachable', () => {
    const seen = new Set<string>();
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T) => {
      const bytes = array as unknown as Uint8Array;
      bytes.forEach((_, index) => {
        bytes[index] = 255 - index;
      });
      return array;
    });

    const random = generateFileFnId('art').slice('art_'.length);
    for (const symbol of random) seen.add(symbol);

    // Bytes 255..236 map to the last 20 symbols of the 32-symbol alphabet.
    expect(random).toBe('zyxwvtsrqpnmkjhgfedc');
    expect(seen.size).toBe(20);
  });
});
