import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import type { StorageAdapter } from '@superfunctions/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDownloadHeaders, createFileFn, matchesContentType, signedDownloadConstraints, type Processor } from '../src/index.js';

type Ctx = { principalId: string; tenantId?: string };

const BASE = 'http://localhost';

describe('read path (FILE-30 F-03, F-04, F-23)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-read-path-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeFileFn(options: { denyReads?: { value: boolean }; storage?: StorageAdapter; processors?: Processor[] } = {}) {
    const denyReads = options.denyReads ?? { value: false };
    return createFileFn({
      database: memoryAdapter(),
      storage: options.storage ?? createLocalStorageAdapter({ rootDir }),
      namespace: 'read_path_test',
      policies: [
        { name: 'any', visibility: 'private' },
        { name: 'images', contentTypes: ['image/*'], visibility: 'private' },
        { name: 'svg', contentTypes: ['image/svg+xml'], visibility: 'private' },
      ],
      auth: {
        resolveSession: async (request) => {
          const user = request.headers.get('x-test-user');
          return user ? { principalId: user, tenantId: 't1' } : null;
        },
      },
      // A host authorizer that can withdraw read access, e.g. a legal hold.
      authorizer: {
        async canRead(file, ctx) {
          return !denyReads.value && file.ownerId === ctx.principalId;
        },
        async canWrite(file, ctx) {
          return file.ownerId === ctx.principalId;
        },
        async canDelete(file, ctx) {
          return file.ownerId === ctx.principalId;
        },
      },
      processing: { enabled: true, processors: options.processors ?? [] },
    });
  }

  async function upload(fileFn: ReturnType<typeof makeFileFn>, ctx: Ctx, policy: string, fileName: string, mimeType: string, text: string) {
    const body = Buffer.from(text);
    const session = await fileFn.createUploadSession({ policy, fileName, size: body.length, mimeType }, ctx);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, ctx);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, ctx);
    return fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, ctx);
  }

  function get(fileFn: ReturnType<typeof makeFileFn>, path: string, user?: string, method = 'GET') {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (user) headers['x-test-user'] = user;
    return fileFn.router.handle(new Request(`${BASE}${path}`, { method, headers, body: method === 'POST' ? '{}' : undefined }));
  }

  it('artifact routes and processing obey an authorizer that denies the read (P3)', async () => {
    const denyReads = { value: false };
    const processors: Processor[] = [
      {
        name: 'copy',
        supportedMimeTypes: ['text/plain'],
        async process(input, getData) {
          return {
            success: true,
            artifacts: [{ kind: 'copy', data: await getData(), mimeType: 'text/plain', storageKey: `${input.storageKey}.copy` }],
          };
        },
      },
    ];
    const fileFn = makeFileFn({ denyReads, processors });
    const alice = { principalId: 'alice', tenantId: 't1' };
    const done = new Promise<void>((resolve) => fileFn.events.once('processing.completed', () => resolve()));
    const file = await upload(fileFn, alice, 'any', 'secret.txt', 'text/plain', 'CONTENT THE AUTHORIZER FORBIDS READING');
    await fileFn.services.processing.triggerProcessingForFile(file.fileId, alice, file.versionId);
    await done;
    const [artifact] = await fileFn.services.processing.listArtifactsForFile(file.fileId, alice);
    expect(artifact).toBeDefined();

    denyReads.value = true;

    expect((await get(fileFn, `/${file.fileId}`, 'alice')).status).toBe(403);
    expect((await get(fileFn, `/${file.fileId}/download`, 'alice')).status).toBe(403);
    expect((await get(fileFn, `/${file.fileId}/artifacts`, 'alice')).status).toBe(403);
    expect((await get(fileFn, `/${file.fileId}/artifacts/${artifact.artifactId}/download`, 'alice')).status).toBe(403);
    expect((await get(fileFn, `/proxy/files/${file.fileId}/artifacts/${artifact.artifactId}/download`, 'alice')).status).toBe(403);
    expect((await get(fileFn, `/${file.fileId}/process`, 'alice', 'POST')).status).toBe(403);

    await expect(fileFn.services.processing.listArtifactsForFile(file.fileId, alice)).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
    await expect(
      fileFn.services.processing.getArtifactDownloadStreamForFile(file.fileId, artifact.artifactId, alice),
    ).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });

    denyReads.value = false;
    expect((await get(fileFn, `/${file.fileId}/artifacts`, 'alice')).status).toBe(200);
  });

  it('serves SVG and HTML as attachments with nosniff and a sandbox CSP, also through a share link (P6)', async () => {
    const fileFn = makeFileFn();
    const alice = { principalId: 'alice', tenantId: 't1' };
    const svg = await upload(fileFn, alice, 'svg', 'logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const html = await upload(fileFn, alice, 'any', 'page.html', 'text/html', '<script>alert(document.domain)</script>');

    const svgResponse = await get(fileFn, `/proxy/files/${svg.fileId}/download`, 'alice');
    expect(svgResponse.status).toBe(200);
    expect(svgResponse.headers.get('content-disposition')).toMatch(/^attachment; filename="logo.svg"/);
    expect(svgResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(svgResponse.headers.get('content-security-policy')).toMatch(/^sandbox; default-src 'none'/);

    const share = await fileFn.services.shares.createShareLink({ fileId: html.fileId }, alice);
    const shared = await get(fileFn, `/proxy/share-links/${share.token}/download`);
    expect(shared.status).toBe(200);
    expect(shared.headers.get('content-disposition')).toMatch(/^attachment; filename="page.html"/);
    expect(shared.headers.get('x-content-type-options')).toBe('nosniff');
    expect(shared.headers.get('content-security-policy')).toMatch(/^sandbox/);
    expect(await shared.text()).toBe('<script>alert(document.domain)</script>');
  });

  it('keeps safe types inline', async () => {
    const fileFn = makeFileFn();
    const alice = { principalId: 'alice', tenantId: 't1' };
    const png = await upload(fileFn, alice, 'images', 'photo.png', 'image/png', 'not really a png');
    const response = await get(fileFn, `/proxy/files/${png.fileId}/download`, 'alice');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe(`inline; filename="photo.png"; filename*=UTF-8''photo.png`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('image/* no longer admits SVG; naming image/svg+xml still does', async () => {
    expect(matchesContentType('image/*', 'image/svg+xml')).toBe(false);
    expect(matchesContentType('image/*', 'IMAGE/SVG+XML; charset=utf-8')).toBe(false);
    expect(matchesContentType('image/*', 'image/png')).toBe(true);
    expect(matchesContentType('image/svg+xml', 'image/svg+xml')).toBe(true);

    const fileFn = makeFileFn();
    await expect(
      fileFn.createUploadSession({ policy: 'images', fileName: 'x.svg', size: 3, mimeType: 'image/svg+xml' }, { principalId: 'alice' }),
    ).rejects.toMatchObject({ code: 'FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED' });
  });

  it('builds download headers and signed URL constraints', () => {
    const headers = buildDownloadHeaders({ contentType: 'Text/HTML; charset=utf-8', size: 5, fileName: 'résumé "x".html' });
    expect(headers['Content-Disposition']).toBe(`attachment; filename="r_sum_ _x_.html"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22x%22.html`);
    expect(buildDownloadHeaders({ contentType: 'application/pdf', size: 1 })['Content-Security-Policy']).not.toMatch(/sandbox/);
    expect(buildDownloadHeaders({ contentType: 'application/pdf', size: 1 })['Content-Disposition']).toBe('inline');
    expect(signedDownloadConstraints('image/svg+xml')).toEqual({ constraints: { responseContentType: 'application/octet-stream' } });
    expect(signedDownloadConstraints('image/png')).toEqual({ constraints: { responseContentType: 'image/png' } });
    expect(signedDownloadConstraints('Image/PNG; x=1')).toEqual({ constraints: { responseContentType: 'image/png' } });

    // A list of types is ambiguous: never inline, never labelled with it.
    const listed = buildDownloadHeaders({ contentType: 'application/pdf; x=1, text/html', size: 1 });
    expect(listed['Content-Disposition']).toBe('attachment');
    expect(listed['Content-Type']).toBe('application/octet-stream');
    expect(listed['Content-Security-Policy']).toMatch(/^sandbox/);
    expect(signedDownloadConstraints('application/pdf, text/html')).toEqual({ constraints: { responseContentType: 'application/octet-stream' } });

    // Malformed parameters are not one well-formed type.
    expect(buildDownloadHeaders({ contentType: 'application/pdf; garbage', size: 1 })['Content-Disposition']).toBe('attachment');
    expect(buildDownloadHeaders({ contentType: 'application/pdf; garbage', size: 1 })['Content-Security-Policy']).toMatch(/^sandbox/);
    expect(buildDownloadHeaders({ contentType: 'application/pdf; name="a;b"', size: 1 })['Content-Disposition']).toBe('inline');
    // text/plain keeps a token charset, on the proxy and on signed URLs.
    expect(buildDownloadHeaders({ contentType: 'text/plain; charset=UTF-16LE', size: 1 })['Content-Type']).toBe('text/plain; charset=utf-16le');
    expect(signedDownloadConstraints('text/plain;charset="utf-8"')).toEqual({ constraints: { responseContentType: 'text/plain; charset=utf-8' } });

    // Parameters are parsed, not searched: a quoted value cannot fake a charset.
    expect(buildDownloadHeaders({ contentType: 'text/plain; note=";charset=windows-1252"; charset=utf-8', size: 1 })['Content-Type'])
      .toBe('text/plain; charset=utf-8');
    // Quoted text outside visible ASCII is not a well-formed type.
    expect(buildDownloadHeaders({ contentType: 'application/pdf; name="\u03A9"', size: 1 })['Content-Disposition']).toBe('attachment');
    expect(buildDownloadHeaders({ contentType: 'application/pdf; name="a\\"b"', size: 1 })['Content-Disposition']).toBe('inline');

    // Empty parameter slots are allowed.
    expect(buildDownloadHeaders({ contentType: 'image/png;', size: 1 })['Content-Disposition']).toBe('inline');
    expect(buildDownloadHeaders({ contentType: 'image/png;; q=1', size: 1 })['Content-Type']).toBe('image/png');
    // Long names are capped, keeping the extension.
    const longName = `${'\u00e9'.repeat(300)}.pdf`;
    const disposition = buildDownloadHeaders({ contentType: 'application/pdf', size: 1, fileName: longName })['Content-Disposition'];
    expect(disposition.length).toBeLessThan(1000);
    expect(disposition.endsWith('.pdf')).toBe(true);

    // A lone surrogate in a stored name does not break the header.
    expect(buildDownloadHeaders({ contentType: 'text/plain', size: 1, fileName: 'a\uD800.txt' })['Content-Disposition'])
      .toBe(`inline; filename="a_.txt"; filename*=UTF-8''a%EF%BF%BD.txt`);
  });

  it('still previews a non-inline image through its raster thumbnail artifact', async () => {
    const fileFn = makeFileFn({
      processors: [{
        name: 'thumb',
        supportedMimeTypes: ['image/tiff'],
        async process(input) {
          return {
            success: true,
            artifacts: [
              // An SVG artifact is never a preview, whatever its kind says.
              { kind: 'thumbnail-small', data: new Uint8Array([1]), mimeType: 'image/svg+xml', storageKey: `${input.storageKey}-thumb-small.svg` },
              { kind: 'thumbnail-medium', data: new Uint8Array([1]), mimeType: 'image/jpeg', storageKey: `${input.storageKey}-thumb-medium.jpg` },
            ],
          };
        },
      }],
    });
    const alice = { principalId: 'alice', tenantId: 't1' };
    const done = new Promise<void>((resolve) => fileFn.events.once('processing.completed', () => resolve()));
    const tiff = await upload(fileFn, alice, 'any', 'scan.tiff', 'image/tiff', 'II*');
    await fileFn.services.processing.triggerProcessingForFile(tiff.fileId, alice, tiff.versionId);
    await done;
    const thumb = await fileFn.services.files.getRenderDescriptor(tiff.fileId, { intent: 'thumbnail' }, alice);
    expect(thumb.source.mode).toBe('artifact');
    expect(thumb.mimeType).toBe('image/jpeg');
  });

  it('gives SVG no image preview, so a render URL never depends on rendering it', async () => {
    const fileFn = makeFileFn();
    const alice = { principalId: 'alice', tenantId: 't1' };
    const svg = await upload(fileFn, alice, 'svg', 'logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const thumb = await fileFn.services.files.getRenderDescriptor(svg.fileId, { intent: 'thumbnail' }, alice);
    expect(thumb.source.mode).toBe('placeholder');
  });

  it('artifact downloads are attachments with a kind-based name, and guests use the anonymous principal', async () => {
    const seen: Array<string | undefined> = [];
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'read_path_guest',
      policies: [{ name: 'any', visibility: 'public' }],
      auth: { required: false, resolveSession: async () => null },
      authorizer: {
        async canRead(_file, ctx) {
          seen.push(ctx.principalId);
          return ctx.principalId === 'anonymous';
        },
        // A write check that would wrongly admit the shared guest principal.
        async canWrite(_file, ctx) { return ctx.principalId === 'anonymous' || ctx.principalId === 'owner'; },
        async canDelete() { return true; },
      },
      processing: {
        enabled: true,
        processors: [{
          name: 'ocr-json',
          supportedMimeTypes: ['text/plain'],
          async process(input, getData) {
            return { success: true, artifacts: [{ kind: 'ocr-json', data: await getData(), mimeType: 'application/json', storageKey: `${input.storageKey}.ocr.json` }] };
          },
        }],
      },
    });
    const owner = { principalId: 'owner' };
    const body = Buffer.from('{"a":1}');
    const session = await fileFn.createUploadSession({ policy: 'any', fileName: 'scan.txt', size: body.length, mimeType: 'text/plain' }, owner);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, owner);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, owner);
    const done = new Promise<void>((resolve) => fileFn.events.once('processing.completed', () => resolve()));
    const file = await fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
    await fileFn.services.processing.triggerProcessingForFile(file.fileId, { principalId: 'anonymous' }, file.versionId);
    await done;

    const list = await fileFn.router.handle(new Request(`http://localhost/${file.fileId}/artifacts`));
    expect(list!.status).toBe(200);
    const [artifact] = (await list!.json()).data.artifacts;
    const download = await fileFn.router.handle(new Request(`http://localhost/proxy/files/${file.fileId}/artifacts/${artifact.artifactId}/download`));
    expect(download!.status).toBe(200);
    expect(download!.headers.get('content-disposition')).toMatch(/^attachment; filename="ocr-json\.json"/);
    expect(seen).not.toContain(undefined);

    // Writes never see a guest as 'anonymous': forced processing is refused.
    const forced = await fileFn.router.handle(new Request(`http://localhost/${file.fileId}/process`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }),
    }));
    expect(forced!.status).toBe(403);
  });
});
