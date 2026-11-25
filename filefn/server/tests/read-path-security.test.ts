import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import type { StorageAdapter } from '@superfunctions/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDownloadHeaders, createFileFn, createProcessingService, matchesContentType, signedDownloadConstraints, type Processor } from '../src/index.js';

type Ctx = { principalId: string; tenantId?: string };

const BASE = 'http://localhost';

/** Uploads a text file through the proxy and waits for its processing to finish. */
async function uploadAndProcess(
  fileFn: ReturnType<typeof createFileFn>,
  owner: { principalId: string },
  policy: string,
  fileName: string,
  text: string,
) {
  const body = Buffer.from(text);
  const session = await fileFn.createUploadSession({ policy, fileName, size: body.length, mimeType: 'text/plain' }, owner);
  const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, owner);
  await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, owner);
  const done = new Promise<void>((resolve) => fileFn.events.once('processing.completed', () => resolve()));
  const file = await fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
  await fileFn.services.processing.triggerProcessingForFile(file.fileId, owner, file.versionId);
  await done;
  return file;
}

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
    // Known aliases of safe types are resolved.
    expect(signedDownloadConstraints('audio/mp3')).toEqual({ constraints: { responseContentType: 'audio/mpeg' } });
    expect(buildDownloadHeaders({ contentType: 'audio/mp3', size: 1 })['Content-Disposition']).toBe('inline');
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
    for (const longName of [`${'\u00e9'.repeat(300)}.pdf`, `${'\u{1F600}'.repeat(96)}.pdf`]) {
      const disposition = buildDownloadHeaders({ contentType: 'application/pdf', size: 1, fileName: longName })['Content-Disposition'];
      expect(disposition.length).toBeLessThanOrEqual(512);
      expect(disposition.endsWith('.pdf')).toBe(true);
    }
    // A huge name is shortened quickly.
    const started = Date.now();
    const huge = buildDownloadHeaders({ contentType: 'text/plain', size: 1, fileName: `${'\u00e9'.repeat(200_000)}.txt` })['Content-Disposition'];
    expect(Date.now() - started).toBeLessThan(500);
    expect(huge.length).toBeLessThanOrEqual(512);
    expect(huge.endsWith('.txt')).toBe(true);
    // A long ASCII name that fits is not shortened.
    const ascii = `${'a'.repeat(120)}.txt`;
    expect(buildDownloadHeaders({ contentType: 'text/plain', size: 1, fileName: ascii })['Content-Disposition']).toContain(ascii);

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

  it('artifact downloads are attachments with a kind-based name; a guest never acts as the anonymous owner', async () => {
    const seen: Array<string | undefined> = [];
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'read_path_guest',
      policies: [{ name: 'any', visibility: 'public' }],
      auth: { required: false, resolveSession: async () => null },
      authorizer: {
        async canRead(file, ctx) {
          seen.push(ctx.principalId);
          return file.visibility === 'public';
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
    const file = await uploadAndProcess(fileFn, owner, 'any', 'scan.txt', '{"a":1}');
    seen.length = 0;

    const list = await fileFn.router.handle(new Request(`http://localhost/${file.fileId}/artifacts`));
    expect(list!.status).toBe(200);
    const [artifact] = (await list!.json()).data.artifacts;
    const download = await fileFn.router.handle(new Request(`http://localhost/proxy/files/${file.fileId}/artifacts/${artifact.artifactId}/download`));
    expect(download!.status).toBe(200);
    expect(download!.headers.get('content-disposition')).toMatch(/^attachment; filename="ocr-json\.json"/);
    // The guest reads as 'anonymous', as on the file routes.
    expect(seen).toContain('anonymous');

    // A forced (write) run by a guest carries no principal: refused.
    const forced = await fileFn.router.handle(new Request(`http://localhost/${file.fileId}/process`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: true }),
    }));
    expect(forced!.status).toBe(403);
  });

  it('guests read only public files on processing routes, whatever the authorizer allows a context without a principal', async () => {
    const processors: Processor[] = [{
      name: 'copy',
      supportedMimeTypes: ['text/plain'],
      async process(input, getData) {
        return { success: true, artifacts: [{ kind: 'copy', data: await getData(), mimeType: 'text/plain', storageKey: `${input.storageKey}.copy` }] };
      },
    }];
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'read_path_guest_private',
      policies: [{ name: 'private', visibility: 'private' }],
      auth: { required: false, resolveSession: async () => null },
      // A host authorizer that treats a missing principal as a trusted server call.
      authorizer: {
        async canRead(file, ctx) { return !ctx.principalId || file.ownerId === ctx.principalId; },
        async canWrite(file, ctx) { return file.ownerId === ctx.principalId; },
        async canDelete(file, ctx) { return file.ownerId === ctx.principalId; },
      },
      processing: { enabled: true, processors },
    });
    const owner = { principalId: 'owner' };
    const file = await uploadAndProcess(fileFn, owner, 'private', 'p.txt', 'private bytes');

    expect((await fileFn.router.handle(new Request(`http://localhost/${file.fileId}/artifacts`)))!.status).toBe(403);
    // The shared 'anonymous' principal is a guest too.
    await expect(fileFn.services.processing.listArtifactsForFile(file.fileId, { principalId: 'anonymous' })).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
    expect((await fileFn.services.processing.listArtifactsForFile(file.fileId, owner))).toHaveLength(1);
  });

  it('a standalone processing service applies its readChecker on every entry point', async () => {
    const database = memoryAdapter();
    const service = createProcessingService({
      db: database,
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'standalone',
      processors: [],
      readChecker: { async canReadFile() { return false; } },
    });
    const now = new Date().toISOString();
    await database.create({ model: 'files', data: { fileId: 'file_a', ownerId: 'o', visibility: 'private', policy: 'p', name: 'a', currentVersionId: 'ver_a', createdAt: now, updatedAt: now }, namespace: 'standalone' });
    await database.create({ model: 'fileArtifacts', data: { artifactId: 'art_a', fileId: 'file_a', versionId: 'ver_a', kind: 'copy', storageKey: 'k', mimeType: 'text/plain', size: 1, createdAt: now }, namespace: 'standalone' });
    await database.create({ model: 'fileArtifacts', data: { artifactId: 'art_orphan', fileId: 'file_gone', versionId: 'ver_x', kind: 'copy', storageKey: 'k2', mimeType: 'text/plain', size: 1, createdAt: now }, namespace: 'standalone' });
    await expect(service.listArtifacts('file_a', { principalId: 'o' })).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
    await expect(service.getArtifactDownloadUrl('art_orphan', { principalId: 'o' })).rejects.toMatchObject({ code: 'FILEFN_NOT_FOUND' });
  });

  it('a standalone service without a readChecker never lets a guest act as the anonymous owner', async () => {
    const database = memoryAdapter();
    const service = createProcessingService({ db: database, storage: createLocalStorageAdapter({ rootDir }), namespace: 'bare', processors: [] });
    const now = new Date().toISOString();
    await database.create({ model: 'files', data: { fileId: 'file_anon', ownerId: 'anonymous', visibility: 'private', policy: 'p', name: 'a', currentVersionId: 'ver_a', createdAt: now, updatedAt: now }, namespace: 'bare' });
    await expect(service.listArtifactsForFile('file_anon', { principalId: 'anonymous' })).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
    await expect(service.listArtifactsForFile('file_anon', {})).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
  });

  it('a standalone service without a readChecker never serves an artifact whose file row is missing', async () => {
    const database = memoryAdapter();
    const service = createProcessingService({ db: database, storage: createLocalStorageAdapter({ rootDir }), namespace: 'bare_orphan', processors: [] });
    const now = new Date().toISOString();
    const owner = { principalId: 'o' };
    await database.create({ model: 'files', data: { fileId: 'file_kept', ownerId: 'o', visibility: 'private', policy: 'p', name: 'a', currentVersionId: 'ver_a', createdAt: now, updatedAt: now }, namespace: 'bare_orphan' });
    await database.create({ model: 'fileArtifacts', data: { artifactId: 'art_kept', fileId: 'file_kept', versionId: 'ver_a', kind: 'copy', storageKey: 'k', mimeType: 'text/plain', size: 1, createdAt: now }, namespace: 'bare_orphan' });
    await database.create({ model: 'fileArtifacts', data: { artifactId: 'art_never', fileId: 'file_never', versionId: 'ver_x', kind: 'copy', storageKey: 'k2', mimeType: 'text/plain', size: 1, createdAt: now }, namespace: 'bare_orphan' });

    // With its file row the artifact still gets a URL (no read check to apply beyond ownership).
    expect((await service.getArtifactDownloadUrl('art_kept', owner)).url).toBe('/proxy/files/file_kept/artifacts/art_kept/download');
    // An artifact whose file row never existed is not served, to anyone.
    await expect(service.getArtifactDownloadUrl('art_never', owner)).rejects.toMatchObject({ code: 'FILEFN_NOT_FOUND' });
    await expect(service.getArtifactDownloadUrl('art_never', {})).rejects.toMatchObject({ code: 'FILEFN_NOT_FOUND' });

    // Deleting the file row orphans its artifact, which is then not served either.
    await database.delete({ model: 'files', where: [{ field: 'fileId', operator: 'eq', value: 'file_kept' }], namespace: 'bare_orphan' });
    await expect(service.getArtifactDownloadUrl('art_kept', owner)).rejects.toMatchObject({ code: 'FILEFN_NOT_FOUND', message: expect.stringContaining('Artifact') });
  });

  it('handles malformed MIME types and quoted charset labels safely', () => {
    expect(() => buildDownloadHeaders({ contentType: 'constructor', size: 1 })).not.toThrow();
    expect(buildDownloadHeaders({ contentType: 'constructor', size: 1 })['Content-Disposition']).toBe('attachment');
    expect(buildDownloadHeaders({ contentType: 'text/plain; charset="iso_8859-2:1987"', size: 1 })['Content-Type']).toBe(
      'text/plain; charset="iso_8859-2:1987"',
    );
  });

  it('never shows a guest a private PDF as still processing', async () => {
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'read_path_guest_pdf',
      policies: [{ name: 'any', visibility: 'private' }],
      // A host authorizer that lets anyone read.
      authorizer: { async canRead() { return true; }, async canWrite() { return true; }, async canDelete() { return true; } },
    });
    const owner = { principalId: 'owner' };
    const body = Buffer.from('%PDF-1.4 test');
    const session = await fileFn.createUploadSession({ policy: 'any', fileName: 'a.pdf', size: body.length, mimeType: 'application/pdf' }, owner);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, owner);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, owner);
    const file = await fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
    const guest = await fileFn.services.files.getRenderDescriptor(file.fileId, { intent: 'thumbnail' }, { principalId: 'anonymous' });
    expect(guest.state).toBe('unsupported');
    const ownerView = await fileFn.services.files.getRenderDescriptor(file.fileId, { intent: 'thumbnail' }, owner);
    expect(ownerView.state).toBe('processing');
  });
});
