import sharp from 'sharp';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile, readdir, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isPublicAddress } from '../src/images/download.js';

import { BrowseFn } from '../src/core/browse-fn.js';
import { ImageBrowser } from '../src/images/browser.js';

const JPEG_BYTES = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();

describe('ImageBrowser', () => {
  let tempRoot: string;
  let server: import('node:http').Server;
  let base: string;
  let hits: number;
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'browsefn-images-'));
    hits = 0;
    server = createServer((request, response) => {
      hits++;
      if (request.url === '/missing') { response.writeHead(404).end(); return; }
      if (request.url === '/redirect') { response.writeHead(302, { location: '/a.jpg' }).end(); return; }
      if (request.url === '/loop') { response.writeHead(302, { location: '/loop' }).end(); return; }
      if (request.url === '/scheme') { response.writeHead(302, { location: 'file:///etc/passwd' }).end(); return; }
      if (request.url === '/large') { response.writeHead(200); response.write(Buffer.alloc(64)); response.end(Buffer.alloc(64)); return; }
      if (request.url === '/declared') { response.writeHead(200, { 'content-length': '99999999' }).flushHeaders(); return; }
      response.end(JPEG_BYTES);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(tempRoot, { recursive: true, force: true });
  });
  const options = { allowPrivateHosts: true };
  it('writes actual HTTP bytes with normalized metadata', async () => {
    const result = await new ImageBrowser().download(`${base}/a.jpg`, { ...options, destination: tempRoot, metadata: true });
    expect(result.metadata).toMatchObject({ width: 3, height: 2, size: JPEG_BYTES.length });
    expect(await readFile(result.path!)).toEqual(Buffer.from(JPEG_BYTES));
  });
  it('preserves order and progress, including item errors', async () => {
    const progress: number[] = [];
    const results = await new ImageBrowser().downloadBatch([`${base}/a.jpg`, `${base}/missing`, `${base}/b.jpg`], {
      ...options, destination: tempRoot, onProgress: (done) => progress.push(done),
    });
    expect(results.map(result => result.success)).toEqual([true, false, true]);
    expect(results[0].path).toBe(join(tempRoot, 'a.jpg'));
    expect(results[2].path).toBe(join(tempRoot, 'b.jpg'));
    expect(progress).toEqual([1, 2, 3]);
  });
  it('enforces redirect budgets, revalidates protocols, and follows relative redirects', async () => {
    const browser = new ImageBrowser();
    expect((await browser.download(`${base}/redirect`, options)).success).toBe(true);
    for (const route of ['loop', 'scheme']) await expect(browser.download(`${base}/${route}`, options)).rejects.toMatchObject({ code: 'SECURITY_POLICY_BLOCKED' });
    await expect(browser.download(`${base}/redirect`, { ...options, maxRedirects: 0 })).rejects.toMatchObject({ code: 'SECURITY_POLICY_BLOCKED' });
  });
  it('downloads the selected provider URL from a remembered search result', async () => {
    const image = { id: '1', url: `${base}/missing`, thumbnail: '', width: 3, height: 2, source: { provider: 'test', url: `${base}/page` }, downloads: { small: `${base}/a.jpg` } };
    const browser = new BrowseFn().images;
    browser.registerProvider({ name: 'test', isAvailable: async () => true, search: async () => ({ query: '', total: 1, page: 1, perPage: 1, provider: 'test', results: [image] }) });
    await browser.search('test');
    const result = await browser.download(image.source.url, { ...options, size: 'small', destination: tempRoot });
    expect(result.success).toBe(true);
    expect(result.path).toBe(join(tempRoot, 'a.jpg'));
    expect(hits).toBe(1);
  });
  it('bounds declared and chunked bodies before writing', async () => {
    for (const route of ['large', 'declared']) await expect(new ImageBrowser().download(`${base}/${route}`, { ...options, maxPayloadBytes: 50, destination: tempRoot })).rejects.toMatchObject({ code: 'DOWNLOAD_TOO_LARGE' });
    expect(await readdir(tempRoot)).toEqual([]);
  });
  it('blocks literal and DNS-resolved local addresses before HTTP traffic', async () => {
    for (const host of ['127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', '[fe80::1]', 'localhost.']) {
      await expect(new ImageBrowser().download(`http://${host}:${(server.address() as AddressInfo).port}/a.jpg`)).rejects.toMatchObject({ code: 'SECURITY_POLICY_BLOCKED' });
    }
    expect(hits).toBe(0);
  });
  it('classifies private, reserved and public IPv4/IPv6 addresses', () => {
    for (const host of ['0.0.0.0', '100.64.0.1', '169.254.169.254', '192.168.1.1', '224.0.0.1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) expect(isPublicAddress(host)).toBe(false);
    for (const host of ['8.8.8.8', '2606:4700:4700::1111']) expect(isPublicAddress(host)).toBe(true);
  });
  it('rejects traversal and out-of-bounds crops', async () => {
    await expect(new ImageBrowser().download(`${base}/a.jpg`, { ...options, destination: tempRoot, filename: '../escape' })).rejects.toMatchObject({ code: 'SECURITY_POLICY_BLOCKED' });
    await expect(new ImageBrowser().download(`${base}/a.jpg`, { ...options, crop: { x: 0, y: 0, width: 100, height: 100 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('atomically enforces overwrite=false for concurrent downloads', async () => {
    const results = await Promise.allSettled([1, 2].map(() => new ImageBrowser().download(`${base}/a.jpg`, { ...options, destination: tempRoot, overwrite: false })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'DOWNLOAD_EXISTS' } });
    expect(await readdir(tempRoot)).toEqual(['a.jpg']);
  });
  it('does not follow destination symbolic links or truncate hardlink targets', async () => {
    const outside = join(tempRoot, 'outside');
    await writeFile(outside, 'keep');
    await symlink(outside, join(tempRoot, 'a.jpg'));
    await new ImageBrowser().download(`${base}/a.jpg`, { ...options, destination: tempRoot });
    expect(await readFile(outside, 'utf8')).toBe('keep');
    await link(outside, join(tempRoot, 'b.jpg'));
    await new ImageBrowser().download(`${base}/b.jpg`, { ...options, destination: tempRoot });
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });
});
