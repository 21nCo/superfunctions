import { afterEach, describe, expect, it, vi } from 'vitest';

// Spy on the `crypto` module's CSPRNG while keeping its real behaviour.
const cryptoMock = vi.hoisted(() => ({ randomFillSync: vi.fn() }));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  cryptoMock.randomFillSync.mockImplementation(actual.randomFillSync);
  return { ...actual, default: actual, randomFillSync: cryptoMock.randomFillSync };
});

import { generateFileFnId, type FileFnIdPrefix } from '../ids.js';

const PREFIXES: FileFnIdPrefix[] = ['upl', 'file', 'ver', 'art'];

afterEach(() => {
  // Not vi.restoreAllMocks(): it would drop the delegating implementation of
  // the hoisted randomFillSync spy.
  vi.unstubAllGlobals();
  cryptoMock.randomFillSync.mockClear();
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

  it('draws from the crypto module CSPRNG, not Math.random', () => {
    const mathRandom = vi.spyOn(Math, 'random');

    try {
      generateFileFnId('file');

      expect(cryptoMock.randomFillSync).toHaveBeenCalledTimes(1);
      expect(mathRandom).not.toHaveBeenCalled();
    } finally {
      mathRandom.mockRestore();
    }
  });

  it('works without a global Web Crypto object (Node 18 default)', () => {
    vi.stubGlobal('crypto', undefined);
    expect(globalThis.crypto).toBeUndefined();

    const ids = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      ids.add(generateFileFnId('upl'));
    }

    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^upl_[0-9a-hjkmnp-tv-z]{20}$/);
  });

  it('maps every random byte onto the alphabet, so each symbol is reachable', () => {
    const seen = new Set<string>();
    cryptoMock.randomFillSync.mockImplementationOnce(<T extends NodeJS.ArrayBufferView>(array: T) => {
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
