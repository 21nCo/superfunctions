import sharp from 'sharp';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transformImage } from '../src/images/transform.js';
import { ImageSelection } from '../src/images/selection.js';
import { ImageBrowser } from '../src/images/browser.js';
import { validateImageDownloadOptions } from '../src/utils/validation.js';
import type { ImageResult } from '../src/core/types.js';

const solid = (width: number, height: number, background: string) => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();

describe('image processing', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'browsefn-transform-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  it.each(['jpeg', 'png', 'webp'] as const)('encodes real %s and returns actual metadata', async format => {
    const result = await transformImage(await solid(100, 50, '#ff0000'), { format, maxWidth: 40 });
    const decoded = await sharp(result.bytes).metadata();
    expect(decoded).toMatchObject({ format, width: 40, height: 20 });
    expect(result.metadata).toMatchObject({ format, width: 40, height: 20, size: result.bytes.length });
  });
  it('crops before resizing and preserves the selected pixels', async () => {
    const input = await sharp(await solid(40, 20, 'red')).composite([{ input: await solid(20, 20, 'blue'), left: 20, top: 0 }]).png().toBuffer();
    const result = await transformImage(input, { crop: { x: 20, y: 0, width: 20, height: 20 }, maxWidth: 10, format: 'png' });
    const decoded = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 10, height: 10 });
    expect([...decoded.data.subarray(0, 3)]).toEqual([0, 0, 255]);
  });
  it('honors quality rather than returning original JPEG bytes', async () => {
    const pixels = Buffer.alloc(64 * 64 * 3);
    for (let index = 0; index < pixels.length; index++) pixels[index] = (index * 73 + Math.floor(index / 7)) % 256;
    const input = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
    const low = await transformImage(input, { format: 'jpeg', quality: 5 });
    const high = await transformImage(input, { format: 'jpeg', quality: 95 });
    expect(low.bytes.length).toBeLessThan(high.bytes.length);
    expect((await sharp(low.bytes).metadata()).format).toBe('jpeg');
  });
  it('places a bounded local image watermark with alpha opacity', async () => {
    const path = join(directory, 'mark.png');
    await writeFile(path, await solid(2, 2, 'white'));
    const result = await transformImage(await solid(8, 8, 'black'), { watermark: { image: path, position: 'top-left', opacity: 0.5 } });
    const raw = await sharp(result.bytes).removeAlpha().raw().toBuffer();
    expect(raw[0]).toBeGreaterThanOrEqual(127);
    expect(raw[0]).toBeLessThanOrEqual(128);
    expect(raw[3 * 7]).toBe(0);
  });
  it('renders literal text and respects zero watermark opacity', async () => {
    const input = await solid(160, 60, 'black');
    const shown = await transformImage(input, { watermark: { text: 'A<&', opacity: 1, position: 'center' } });
    const hidden = await transformImage(input, { watermark: { text: 'A<&', opacity: 0 } });
    expect((await sharp(shown.bytes).removeAlpha().raw().toBuffer()).some(value => value > 0)).toBe(true);
    expect((await sharp(hidden.bytes).removeAlpha().raw().toBuffer()).every(value => value === 0)).toBe(true);
  });
  it('applies direct URL size bounds without enlarging and preserves original', async () => {
    const input = await solid(1000, 500, 'red');
    expect((await transformImage(input, { size: 'small' })).metadata).toMatchObject({ width: 640, height: 320 });
    expect((await transformImage(input, { size: 'original' })).bytes).toEqual(input);
    expect((await transformImage(await solid(10, 5, 'red'), { maxWidth: 100 })).metadata.width).toBe(10);
  });
  it('rejects corruption, out-of-bounds crops, and private watermark URLs', async () => {
    await expect(transformImage(Buffer.from('not an image'), {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(transformImage(await solid(10, 10, 'red'), { crop: { x: 9, y: 0, width: 2, height: 2 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(transformImage(await solid(10, 10, 'red'), { watermark: { image: 'http://127.0.0.1/secret' } })).rejects.toMatchObject({ code: 'SECURITY_POLICY_BLOCKED' });
    expect(() => validateImageDownloadOptions({ maxWidth: 0 })).toThrow();
  });
  it('selects provider URLs for explicit results and remembered URLs', () => {
    const image = { url: 'https://example.com/default', source: { provider: 'test', url: 'https://example.com/page' }, downloads: { small: 'https://example.com/small', original: 'https://example.com/raw' } } as ImageResult;
    const selection = new ImageSelection();
    expect(selection.resolve(image, { size: 'small' })).toEqual({ url: image.downloads!.small, options: { size: undefined } });
    expect(() => selection.resolve(image, { size: 'large' })).toThrow('no large download URL');
    selection.remember([image]);
    expect(selection.resolve(image.source.url, { size: 'original' }).url).toBe(image.downloads!.original);
    expect(selection.resolve('https://other.com/a', { size: 'small' }).options.size).toBe('small');
  });
  it('preserves custom provider download capabilities and selected URL', async () => {
    const browser = new ImageBrowser();
    const seen: string[] = [];
    browser.registerProvider({ name: 'test', isAvailable: async () => true, search: async () => ({ results: [], query: '', total: 0, page: 1, perPage: 1, provider: 'test' }), download: async (url, options) => { seen.push(url); expect(options.format).toBe('webp'); expect(options.size).toBe('small'); return { success: true }; } });
    const image = { url: 'https://example.com/default', downloads: { small: 'https://example.com/small' } } as ImageResult;
    expect((await browser.download(image, { size: 'small', format: 'webp' })).success).toBe(true);
    expect(seen).toEqual(['https://example.com/small']);
  });
});
