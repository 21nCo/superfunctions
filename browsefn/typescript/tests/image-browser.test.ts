import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageBrowser } from '../src/images/browser.js';

const JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
  0x00, 0x48, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
  0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff,
  0xd9,
]);

describe('ImageBrowser', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'browsefn-images-'));
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('writes a real file and returns normalized metadata for single downloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': String(JPEG_BYTES.length) }),
      arrayBuffer: async () =>
        JPEG_BYTES.buffer.slice(
          JPEG_BYTES.byteOffset,
          JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength
        ),
    } as Response);

    const browser = new ImageBrowser();
    const result = await browser.download('https://images.example.com/a.jpg', {
      destination: tempRoot,
      filename: 'a.jpg',
      overwrite: false,
      metadata: true,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(join(tempRoot, 'a.jpg'));
    expect(result.metadata).toMatchObject({
      format: 'jpeg',
      width: 3,
      height: 2,
      size: JPEG_BYTES.length,
    });

    const written = await readFile(join(tempRoot, 'a.jpg'));
    expect(Buffer.compare(written, Buffer.from(JPEG_BYTES))).toBe(0);
  });

  it('fails with DOWNLOAD_EXISTS when overwrite is disabled', async () => {
    const destination = join(tempRoot, 'a.jpg');
    await writeFile(destination, Buffer.from('existing'));

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      arrayBuffer: async () =>
        JPEG_BYTES.buffer.slice(
          JPEG_BYTES.byteOffset,
          JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength
        ),
    } as Response);

    const browser = new ImageBrowser();

    await expect(
      browser.download('https://images.example.com/a.jpg', {
        destination: tempRoot,
        filename: 'a.jpg',
        overwrite: false,
      })
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_EXISTS',
      message: 'Destination file already exists and overwrite is disabled.',
    });
  });

  it('preserves input order and reports monotonic progress in batch downloads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/a.jpg')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': String(JPEG_BYTES.length) }),
        arrayBuffer: async () =>
          JPEG_BYTES.buffer.slice(
            JPEG_BYTES.byteOffset,
            JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength
          ),
      } as Response;
    });

    const progressCalls: Array<[number, number]> = [];
    const browser = new ImageBrowser();
    const results = await browser.downloadBatch(
      [
        'https://images.example.com/a.jpg',
        'https://images.example.com/b.jpg',
      ],
      {
        destination: tempRoot,
        concurrency: 2,
        onProgress: (completed, total) => {
          progressCalls.push([completed, total]);
        },
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0].path).toBe(join(tempRoot, 'a.jpg'));
    expect(results[1].path).toBe(join(tempRoot, 'b.jpg'));
    expect(progressCalls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('captures per-item errors without reordering batch results', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/b.jpg')) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: new Headers(),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': String(JPEG_BYTES.length) }),
        arrayBuffer: async () =>
          JPEG_BYTES.buffer.slice(
            JPEG_BYTES.byteOffset,
            JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength
          ),
      } as Response;
    });

    const browser = new ImageBrowser();
    const results = await browser.downloadBatch(
      [
        'https://images.example.com/a.jpg',
        'https://images.example.com/b.jpg',
      ],
      { destination: tempRoot }
    );

    expect(results[0]).toMatchObject({
      success: true,
      path: join(tempRoot, 'a.jpg'),
    });
    expect(results[1]).toEqual({
      success: false,
      error: 'HTTP 404: Not Found',
    });
  });

  it('rejects path traversal outside the destination root', async () => {
    const browser = new ImageBrowser();

    await expect(
      browser.download('https://images.example.com/a.jpg', {
        destination: tempRoot,
        filename: '../../token.txt',
      })
    ).rejects.toMatchObject({
      code: 'SECURITY_POLICY_BLOCKED',
      message: 'Download path escapes the destination root.',
    });
  });

  it('blocks private hosts by default for downloads', async () => {
    const browser = new ImageBrowser();

    await expect(
      browser.download('http://127.0.0.1/admin.jpg', {
        destination: tempRoot,
      })
    ).rejects.toMatchObject({
      code: 'SECURITY_POLICY_BLOCKED',
      message: 'Target host is not allowed by the active security policy.',
    });
  });

  it('rejects transform options before writing any file', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': String(JPEG_BYTES.length) }),
      arrayBuffer: async () =>
        JPEG_BYTES.buffer.slice(
          JPEG_BYTES.byteOffset,
          JPEG_BYTES.byteOffset + JPEG_BYTES.byteLength
        ),
    } as Response);

    const browser = new ImageBrowser();
    await expect(
      browser.download('https://images.example.com/a.jpg', {
        destination: tempRoot,
        maxWidth: 100,
      })
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Image transforms are not supported in the TypeScript runtime yet.',
    });
  });
});
