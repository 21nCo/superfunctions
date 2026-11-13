import type { UploadSessionRoutes } from './upload-sessions/routes.js';
import type { FileRoutes } from './files/routes.js';
import type { GrantsRoutes } from './authz/grants.routes.js';
import type { SharesRoutes } from './shares/routes.js';
import type { ProcessingRoutes } from './processing/routes.js';
import type { PolicyRoutes } from './policies.routes.js';
import type { QuotaRoutes } from './quota.routes.js';

export interface FileFnRouterConfig {
  uploadRoutes: UploadSessionRoutes;
  fileRoutes: FileRoutes;
  grantsRoutes?: GrantsRoutes;
  sharesRoutes?: SharesRoutes;
  processingRoutes?: ProcessingRoutes;
  policyRoutes?: PolicyRoutes;
  quotaRoutes?: QuotaRoutes;
  /** Path prefix every route is served under, e.g. `/files`. Omitted, `''` or `/` serves routes at the root. */
  basePath?: string;
}

/**
 * Normalizes a mount prefix to `''` (root) or `/segment[/segment...]` without a
 * trailing slash. Throws FILEFN_BASE_PATH_INVALID unless the value is an
 * absolute, already-encoded URL path: a leading `/`, no empty or dot segment,
 * and no query, fragment, whitespace or other byte `URL` would percent-encode.
 */
export function normalizeBasePath(basePath: string | undefined): string {
  if (basePath === undefined || basePath === '' || basePath === '/') {
    return '';
  }
  const invalid = () =>
    new Error(`FILEFN_BASE_PATH_INVALID: basePath must be an absolute path like "/files", got ${JSON.stringify(basePath)}`);
  if (typeof basePath !== 'string' || !basePath.startsWith('/')) {
    throw invalid();
  }
  const trimmed = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (trimmed.slice(1).split('/').includes('')) {
    throw invalid();
  }
  // Request paths are compared as URL#pathname reports them, so the prefix must
  // already be in that form: no query, fragment, dot segment, or unencoded byte.
  if (new URL(trimmed, 'http://filefn.invalid').pathname !== trimmed) {
    throw invalid();
  }
  return trimmed;
}

/** Returns the route path under a normalized `basePath`, or null when the request path is outside it. */
export function stripBasePath(path: string, basePath: string): string | null {
  if (!basePath) return path;
  if (path === basePath) return '/';
  if (path.startsWith(`${basePath}/`)) return path.slice(basePath.length);
  return null;
}

export function createRouter(config: FileFnRouterConfig) {
  const { uploadRoutes, fileRoutes, grantsRoutes, sharesRoutes, processingRoutes, policyRoutes, quotaRoutes } = config;
  const basePath = normalizeBasePath(config.basePath);
  const reservedTopLevelPaths = new Set([
    'upload',
    'policies',
    'quota',
    'proxy',
    'grants',
    'shares',
    'processing',
  ]);

  return {
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const path = stripBasePath(url.pathname, basePath);
      if (path === null) {
        return null; // Outside this router's basePath
      }
      const method = request.method;

      // Upload session routes
      if (path === '/upload/init' && method === 'POST') {
        return uploadRoutes.initSession(request);
      }

      const statusMatch = path.match(/^\/upload\/([^/]+)\/status$/);
      if (statusMatch && method === 'GET') {
        return uploadRoutes.getStatus(request, statusMatch[1]);
      }

      const signMatch = path.match(/^\/upload\/([^/]+)\/parts\/(\d+)\/sign$/);
      if (signMatch && method === 'POST') {
        return uploadRoutes.signPart(request, signMatch[1], parseInt(signMatch[2], 10));
      }

      const completePartMatch = path.match(/^\/upload\/([^/]+)\/parts\/(\d+)\/complete$/);
      if (completePartMatch && method === 'POST') {
        return uploadRoutes.completePart(request, completePartMatch[1], parseInt(completePartMatch[2], 10));
      }

      const uploadPartMatch = path.match(/^\/upload\/([^/]+)\/parts\/(\d+)$/);
      if (uploadPartMatch && method === 'PUT') {
        return uploadRoutes.uploadPartBytes(request, uploadPartMatch[1], parseInt(uploadPartMatch[2], 10));
      }

      const completeMatch = path.match(/^\/upload\/([^/]+)\/complete$/);
      if (completeMatch && method === 'POST') {
        return uploadRoutes.completeSession(request, completeMatch[1]);
      }

      const abortMatch = path.match(/^\/upload\/([^/]+)\/abort$/);
      if (abortMatch && method === 'POST') {
        return uploadRoutes.abortSession(request, abortMatch[1]);
      }

      // Policy routes
      if (policyRoutes && path === '/policies' && method === 'GET') {
        return policyRoutes.listPolicies(request);
      }

      // Quota routes
      if (quotaRoutes && path === '/quota/storage' && method === 'GET') {
        return quotaRoutes.getStorageQuota(request);
      }

      // File routes
      if (path === '/' && method === 'GET') {
        return fileRoutes.listFiles(request);
      }

      // Keep reserved route prefixes above file-id routing so top-level resources never shadow explicit handlers.
      const fileMatch = path.match(/^\/([^/]+)$/);
      const isFileRoute = fileMatch && !reservedTopLevelPaths.has(fileMatch[1]);
      if (isFileRoute && method === 'GET') {
        return fileRoutes.getFile(request, fileMatch[1]);
      }

      if (isFileRoute && method === 'DELETE') {
        return fileRoutes.deleteFile(request, fileMatch[1]);
      }

      const downloadMatch = path.match(/^\/([^/]+)\/download$/);
      if (downloadMatch && method === 'GET') {
        return fileRoutes.downloadFile(request, downloadMatch[1]);
      }

      const renderMatch = path.match(/^\/([^/]+)\/render$/);
      if (renderMatch && method === 'GET') {
        return fileRoutes.renderFile(request, renderMatch[1]);
      }

      const versionsMatch = path.match(/^\/([^/]+)\/versions$/);
      if (versionsMatch && method === 'GET') {
        return fileRoutes.listVersions(request, versionsMatch[1]);
      }

      const versionDownloadMatch = path.match(/^\/([^/]+)\/versions\/([^/]+)\/download$/);
      if (versionDownloadMatch && method === 'GET') {
        return fileRoutes.downloadFile(request, versionDownloadMatch[1], versionDownloadMatch[2]);
      }

      const versionMetadataMatch = path.match(/^\/([^/]+)\/versions\/([^/]+)$/);
      if (versionMetadataMatch && method === 'GET') {
        return fileRoutes.getVersion(request, versionMetadataMatch[1], versionMetadataMatch[2]);
      }

      // Proxy download routes
      const proxyDownloadMatch = path.match(/^\/proxy\/files\/([^/]+)\/download$/);
      if (proxyDownloadMatch && method === 'GET') {
        return fileRoutes.proxyDownloadFile(request, proxyDownloadMatch[1]);
      }

      const proxyVersionDownloadMatch = path.match(/^\/proxy\/files\/([^/]+)\/versions\/([^/]+)\/download$/);
      if (proxyVersionDownloadMatch && method === 'GET') {
        return fileRoutes.proxyDownloadFile(request, proxyVersionDownloadMatch[1], proxyVersionDownloadMatch[2]);
      }

      if (sharesRoutes) {
        const proxyShareDownloadMatch = path.match(/^\/proxy\/share-links\/([^/]+)\/download$/);
        if (proxyShareDownloadMatch && method === 'GET') {
          return sharesRoutes.proxyDownloadViaShareLink(request, proxyShareDownloadMatch[1]);
        }
      }

      // Grant routes
      if (grantsRoutes) {
        const permissionsMatch = path.match(/^\/([^/]+)\/permissions$/);
        if (permissionsMatch && method === 'POST') {
          return grantsRoutes.createGrant(request, permissionsMatch[1]);
        }
        if (permissionsMatch && method === 'GET') {
          return grantsRoutes.listGrants(request, permissionsMatch[1]);
        }

        const revokePermissionMatch = path.match(/^\/([^/]+)\/permissions\/([^/]+)$/);
        if (revokePermissionMatch && method === 'DELETE') {
          return grantsRoutes.revokeGrant(request, revokePermissionMatch[1], revokePermissionMatch[2]);
        }
      }

      // Share link routes
      if (sharesRoutes) {
        const shareLinksMatch = path.match(/^\/([^/]+)\/share-links$/);
        if (shareLinksMatch && method === 'POST') {
          return sharesRoutes.createShareLink(request, shareLinksMatch[1]);
        }
        if (shareLinksMatch && method === 'GET') {
          return sharesRoutes.listShareLinks(request, shareLinksMatch[1]);
        }

        const shareLinkDownloadMatch = path.match(/^\/share-links\/([^/]+)\/download$/);
        if (shareLinkDownloadMatch && method === 'GET') {
          return sharesRoutes.downloadViaShareLink(request, shareLinkDownloadMatch[1]);
        }

        const revokeShareMatch = path.match(/^\/([^/]+)\/share-links\/([^/]+)$/);
        if (revokeShareMatch && method === 'DELETE') {
          return sharesRoutes.revokeShareLink(request, revokeShareMatch[1], revokeShareMatch[2]);
        }
      }

      // Processing routes
      if (processingRoutes) {
        const artifactsMatch = path.match(/^\/([^/]+)\/artifacts$/);
        if (artifactsMatch && method === 'GET') {
          return processingRoutes.listArtifacts(request, artifactsMatch[1]);
        }

        const artifactDownloadMatch = path.match(/^\/([^/]+)\/artifacts\/([^/]+)\/download$/);
        if (artifactDownloadMatch && method === 'GET') {
          return processingRoutes.downloadArtifact(request, artifactDownloadMatch[1], artifactDownloadMatch[2]);
        }

        const proxyArtifactDownloadMatch = path.match(/^\/proxy\/files\/([^/]+)\/artifacts\/([^/]+)\/download$/);
        if (proxyArtifactDownloadMatch && method === 'GET') {
          return processingRoutes.proxyDownloadArtifact(request, proxyArtifactDownloadMatch[1], proxyArtifactDownloadMatch[2]);
        }

        const processMatch = path.match(/^\/([^/]+)\/process$/);
        if (processMatch && method === 'POST') {
          return processingRoutes.triggerProcessing(request, processMatch[1]);
        }
      }

      return null; // Route not found
    },
  };
}

export type FileFnRouter = ReturnType<typeof createRouter>;
