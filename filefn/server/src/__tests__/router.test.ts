import { describe, expect, it, vi } from 'vitest';
import { createRouter, normalizeBasePath } from '../router.js';

function createMockRoutes() {
  return {
    uploadRoutes: {
      initSession: vi.fn(async () => new Response('upload-init')),
      getStatus: vi.fn(async () => new Response('upload-status')),
      signPart: vi.fn(async () => new Response('upload-sign')),
      completePart: vi.fn(async () => new Response('upload-complete-part')),
      uploadPartBytes: vi.fn(async () => new Response('upload-part')),
      completeSession: vi.fn(async () => new Response('upload-complete')),
      abortSession: vi.fn(async () => new Response('upload-abort')),
    },
    fileRoutes: {
      listFiles: vi.fn(async () => new Response('list-files')),
      getFile: vi.fn(async () => new Response('get-file')),
      deleteFile: vi.fn(async () => new Response('delete-file')),
      downloadFile: vi.fn(async () => new Response('download-file')),
      renderFile: vi.fn(async () => new Response('render-file')),
      listVersions: vi.fn(async () => new Response('list-versions')),
      getVersion: vi.fn(async () => new Response('get-version')),
      proxyDownloadFile: vi.fn(async () => new Response('proxy-download-file')),
    },
    policyRoutes: {
      listPolicies: vi.fn(async () => new Response('policies')),
    },
    quotaRoutes: {
      getStorageQuota: vi.fn(async () => new Response('quota')),
    },
    grantsRoutes: {
      createGrant: vi.fn(async () => new Response('create-grant')),
      listGrants: vi.fn(async () => new Response('list-grants')),
      revokeGrant: vi.fn(async () => new Response('revoke-grant')),
    },
    sharesRoutes: {
      createShareLink: vi.fn(async () => new Response('create-share')),
      listShareLinks: vi.fn(async () => new Response('list-share')),
      downloadViaShareLink: vi.fn(async () => new Response('share-download')),
      revokeShareLink: vi.fn(async () => new Response('revoke-share')),
      proxyDownloadViaShareLink: vi.fn(async () => new Response('proxy-share-download')),
    },
    processingRoutes: {
      listArtifacts: vi.fn(async () => new Response('list-artifacts')),
      downloadArtifact: vi.fn(async () => new Response('download-artifact')),
      proxyDownloadArtifact: vi.fn(async () => new Response('proxy-download-artifact')),
      triggerProcessing: vi.fn(async () => new Response('trigger-processing')),
    },
  };
}

describe('createRouter', () => {
  it('does not let reserved top-level routes shadow explicit handlers', async () => {
    const routes = createMockRoutes();
    const router = createRouter(routes as any);

    const response = await router.handle(new Request('https://example.com/policies', { method: 'GET' }));

    expect(await response?.text()).toBe('policies');
    expect(routes.policyRoutes.listPolicies).toHaveBeenCalledTimes(1);
    expect(routes.fileRoutes.getFile).not.toHaveBeenCalled();
  });
});

type MockRoutes = ReturnType<typeof createMockRoutes>;

interface RouteCase {
  family: string;
  method: string;
  path: string;
  body: string;
  handler: (routes: MockRoutes) => ReturnType<typeof vi.fn>;
  args: unknown[];
}

// One case per route the router serves; a legacy-shaped ID keeps routing (IDs are opaque).
const ROUTE_CASES: RouteCase[] = [
  { family: 'upload', method: 'POST', path: '/upload/init', body: 'upload-init', handler: (r) => r.uploadRoutes.initSession, args: [] },
  { family: 'upload', method: 'GET', path: '/upload/upl_1/status', body: 'upload-status', handler: (r) => r.uploadRoutes.getStatus, args: ['upl_1'] },
  { family: 'upload', method: 'POST', path: '/upload/upl_1/parts/2/sign', body: 'upload-sign', handler: (r) => r.uploadRoutes.signPart, args: ['upl_1', 2] },
  { family: 'upload', method: 'POST', path: '/upload/upl_1/parts/2/complete', body: 'upload-complete-part', handler: (r) => r.uploadRoutes.completePart, args: ['upl_1', 2] },
  { family: 'upload', method: 'PUT', path: '/upload/upl_1/parts/2', body: 'upload-part', handler: (r) => r.uploadRoutes.uploadPartBytes, args: ['upl_1', 2] },
  { family: 'upload', method: 'POST', path: '/upload/upl_1/complete', body: 'upload-complete', handler: (r) => r.uploadRoutes.completeSession, args: ['upl_1'] },
  { family: 'upload', method: 'POST', path: '/upload/upl_1/abort', body: 'upload-abort', handler: (r) => r.uploadRoutes.abortSession, args: ['upl_1'] },
  { family: 'policies', method: 'GET', path: '/policies', body: 'policies', handler: (r) => r.policyRoutes.listPolicies, args: [] },
  { family: 'quota', method: 'GET', path: '/quota/storage', body: 'quota', handler: (r) => r.quotaRoutes.getStorageQuota, args: [] },
  { family: 'files', method: 'GET', path: '/', body: 'list-files', handler: (r) => r.fileRoutes.listFiles, args: [] },
  { family: 'files', method: 'GET', path: '/file_1', body: 'get-file', handler: (r) => r.fileRoutes.getFile, args: ['file_1'] },
  { family: 'files', method: 'GET', path: '/file_lx2k9a_q8w3e1', body: 'get-file', handler: (r) => r.fileRoutes.getFile, args: ['file_lx2k9a_q8w3e1'] },
  { family: 'files', method: 'DELETE', path: '/file_1', body: 'delete-file', handler: (r) => r.fileRoutes.deleteFile, args: ['file_1'] },
  { family: 'files', method: 'GET', path: '/file_1/download', body: 'download-file', handler: (r) => r.fileRoutes.downloadFile, args: ['file_1'] },
  { family: 'files', method: 'GET', path: '/file_1/render', body: 'render-file', handler: (r) => r.fileRoutes.renderFile, args: ['file_1'] },
  { family: 'files', method: 'GET', path: '/file_1/versions', body: 'list-versions', handler: (r) => r.fileRoutes.listVersions, args: ['file_1'] },
  { family: 'files', method: 'GET', path: '/file_1/versions/ver_1/download', body: 'download-file', handler: (r) => r.fileRoutes.downloadFile, args: ['file_1', 'ver_1'] },
  { family: 'files', method: 'GET', path: '/file_1/versions/ver_1', body: 'get-version', handler: (r) => r.fileRoutes.getVersion, args: ['file_1', 'ver_1'] },
  { family: 'proxy', method: 'GET', path: '/proxy/files/file_1/download', body: 'proxy-download-file', handler: (r) => r.fileRoutes.proxyDownloadFile, args: ['file_1'] },
  { family: 'proxy', method: 'GET', path: '/proxy/files/file_1/versions/ver_1/download', body: 'proxy-download-file', handler: (r) => r.fileRoutes.proxyDownloadFile, args: ['file_1', 'ver_1'] },
  { family: 'proxy', method: 'GET', path: '/proxy/share-links/tok_1/download', body: 'proxy-share-download', handler: (r) => r.sharesRoutes.proxyDownloadViaShareLink, args: ['tok_1'] },
  { family: 'proxy', method: 'GET', path: '/proxy/files/file_1/artifacts/art_1/download', body: 'proxy-download-artifact', handler: (r) => r.processingRoutes.proxyDownloadArtifact, args: ['file_1', 'art_1'] },
  { family: 'grants', method: 'POST', path: '/file_1/permissions', body: 'create-grant', handler: (r) => r.grantsRoutes.createGrant, args: ['file_1'] },
  { family: 'grants', method: 'GET', path: '/file_1/permissions', body: 'list-grants', handler: (r) => r.grantsRoutes.listGrants, args: ['file_1'] },
  { family: 'grants', method: 'DELETE', path: '/file_1/permissions/perm_1', body: 'revoke-grant', handler: (r) => r.grantsRoutes.revokeGrant, args: ['file_1', 'perm_1'] },
  { family: 'shares', method: 'POST', path: '/file_1/share-links', body: 'create-share', handler: (r) => r.sharesRoutes.createShareLink, args: ['file_1'] },
  { family: 'shares', method: 'GET', path: '/file_1/share-links', body: 'list-share', handler: (r) => r.sharesRoutes.listShareLinks, args: ['file_1'] },
  { family: 'shares', method: 'GET', path: '/share-links/tok_1/download', body: 'share-download', handler: (r) => r.sharesRoutes.downloadViaShareLink, args: ['tok_1'] },
  { family: 'shares', method: 'DELETE', path: '/file_1/share-links/shr_1', body: 'revoke-share', handler: (r) => r.sharesRoutes.revokeShareLink, args: ['file_1', 'shr_1'] },
  { family: 'processing', method: 'GET', path: '/file_1/artifacts', body: 'list-artifacts', handler: (r) => r.processingRoutes.listArtifacts, args: ['file_1'] },
  { family: 'processing', method: 'GET', path: '/file_1/artifacts/art_1/download', body: 'download-artifact', handler: (r) => r.processingRoutes.downloadArtifact, args: ['file_1', 'art_1'] },
  { family: 'processing', method: 'POST', path: '/file_1/process', body: 'trigger-processing', handler: (r) => r.processingRoutes.triggerProcessing, args: ['file_1'] },
];

const ORIGIN = 'https://example.com';

function expectOnlyHandlerCalled(routes: MockRoutes, handler: ReturnType<typeof vi.fn>): void {
  for (const group of Object.values(routes)) {
    for (const fn of Object.values(group) as ReturnType<typeof vi.fn>[]) {
      if (fn !== handler) expect(fn).not.toHaveBeenCalled();
    }
  }
}

function routePath(path: string, basePath: string): string {
  return path === '/' ? basePath || '/' : `${basePath}${path}`;
}

describe('createRouter basePath', () => {
  it('covers every route family', () => {
    expect(new Set(ROUTE_CASES.map((c) => c.family))).toEqual(
      new Set(['upload', 'policies', 'quota', 'files', 'proxy', 'grants', 'shares', 'processing']),
    );
  });

  describe.each([
    { label: 'without basePath', config: {}, prefix: '' },
    { label: "with basePath ''", config: { basePath: '' }, prefix: '' },
    { label: "with basePath '/'", config: { basePath: '/' }, prefix: '' },
    { label: "with basePath '/files'", config: { basePath: '/files' }, prefix: '/files' },
    { label: "with basePath '/files/'", config: { basePath: '/files/' }, prefix: '/files' },
    { label: "with basePath '/api/v1/files'", config: { basePath: '/api/v1/files' }, prefix: '/api/v1/files' },
  ])('$label', ({ config, prefix }) => {
    it.each(ROUTE_CASES)('$method $path ($family)', async (route) => {
      const routes = createMockRoutes();
      const router = createRouter({ ...(routes as any), ...config });
      const request = new Request(`${ORIGIN}${routePath(route.path, prefix)}?x=1`, { method: route.method });

      const response = await router.handle(request);

      expect(await response?.text()).toBe(route.body);
      const handler = route.handler(routes);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]).toEqual([request, ...route.args]);
      expectOnlyHandlerCalled(routes, handler);
    });
  });

  it.each(ROUTE_CASES)('does not serve $method $path at the root when mounted under /files', async (route) => {
    const routes = createMockRoutes();
    const router = createRouter({ ...(routes as any), basePath: '/files' });

    const response = await router.handle(new Request(`${ORIGIN}${route.path}`, { method: route.method }));

    expect(response).toBeNull();
    expectOnlyHandlerCalled(routes, vi.fn());
  });

  it('serves the mount root with and without a trailing slash', async () => {
    const routes = createMockRoutes();
    const router = createRouter({ ...(routes as any), basePath: '/files' });

    expect(await (await router.handle(new Request(`${ORIGIN}/files`)))?.text()).toBe('list-files');
    expect(await (await router.handle(new Request(`${ORIGIN}/files/`)))?.text()).toBe('list-files');
    expect(routes.fileRoutes.listFiles).toHaveBeenCalledTimes(2);
  });

  it('matches the prefix on a segment boundary and case-sensitively', async () => {
    const routes = createMockRoutes();
    const router = createRouter({ ...(routes as any), basePath: '/files' });

    for (const path of ['/filesx', '/filesx/file_1', '/Files/file_1', '/other/files/file_1', '/file_1']) {
      expect(await router.handle(new Request(`${ORIGIN}${path}`))).toBeNull();
    }
    expectOnlyHandlerCalled(routes, vi.fn());
  });

  it('routes a file whose ID equals the mount segment', async () => {
    const routes = createMockRoutes();
    const router = createRouter({ ...(routes as any), basePath: '/files' });

    await router.handle(new Request(`${ORIGIN}/files/files`));

    expect(routes.fileRoutes.getFile).toHaveBeenCalledWith(expect.any(Request), 'files');
  });
});

describe('normalizeBasePath', () => {
  it.each([
    [undefined, ''],
    ['', ''],
    ['/', ''],
    ['/files', '/files'],
    ['/files/', '/files'],
    ['/a/b-c_d.e~f/%20g', '/a/b-c_d.e~f/%20g'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });

  it.each(['files', 'https://example.com/files', '//files', '/files//', '/a//b', '/a/./b', '/a/../b', '/..', '/files?x=1', '/files#top', '/my files', '/a\\b', '/fïles'])(
    'rejects %j',
    (input) => {
      expect(() => normalizeBasePath(input)).toThrow(/^FILEFN_BASE_PATH_INVALID/);
    },
  );

  it('rejects a non-string value from an untyped caller', () => {
    expect(() => normalizeBasePath(42 as unknown as string)).toThrow(/^FILEFN_BASE_PATH_INVALID/);
  });
});
