import type { Adapter, WhereClause } from '@superfunctions/db';
import { getStorageCapabilities, type StorageAdapter } from '@superfunctions/storage';
import type { FileProviderContext } from '@superfunctions/files';
import type { FileFnEventEmitter } from '../events.js';
import type { Logger } from '../observability/logger.js';
import { FILE_DELETED_CLAIM, type QuotaProvider } from '../upload-sessions/service.js';
import { resolveArtifactStorageTarget, resolveStorageTarget, type PolicyRegistry } from '../policies.js';
import { contentTypeEssence, isInlineSafeContentType, signedDownloadConstraints } from '../download-headers.js';
import * as errors from '../errors.js';
import { createFileDeletedEvent } from '../events.js';
import { artifactSourceOf } from '../processing/client-artifacts.js';
import {
  DISPLACED_OBJECT_KIND,
  PROCESSING_RUN_KIND,
  UPLOAD_INTENT_KIND,
  recordedStorageTarget,
} from '../processing/service.js';
import { findReferencedStorageRefs, parseStorageRef, storageRef } from '../storage-references.js';
import { createImportObject } from './import.js';
import { isGrantExpired } from '../authz/grant-expiry.js';
import { isFileOwner } from '../authz/ownership.js';

/** Kinds of the rows recording an artifact object no artifact row names (see the processing service). */
const RECORD_KINDS = [DISPLACED_OBJECT_KIND, UPLOAD_INTENT_KIND];

export interface FileRecord {
  fileId: string;
  currentVersionId: string;
  ownerId: string;
  tenantId: string | null;
  visibility: 'private' | 'shared' | 'public';
  policy: string;
  mimeType: string;
  size: number;
  name: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FileVersionRecord {
  versionId: string;
  fileId: string;
  storageKey: string;
  mimeType: string;
  size: number;
  checksumSha256Base64: string | null;
  createdAt: string;
}

interface FileArtifactRecord {
  artifactId: string;
  fileId: string;
  versionId: string;
  kind: string;
  storageKey: string;
  mimeType: string;
  size?: number | null;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

interface UploadSessionRecord {
  uploadSessionId: string;
  status: 'pending' | 'in_progress' | 'completing' | 'publishing' | 'completed' | 'aborted' | 'refused' | 'expired';
  completionPublication?: (Record<string, unknown> & { fileDeleted?: boolean }) | null;
  policy: string;
  uploadMode: string;
  storageKey: string;
  storageUploadId: string | null;
}

interface UploadPartRecord {
  partNumber: number;
}

interface FilePermissionGrantRecord {
  fileId: string;
  userId?: string;
  tenantId?: string | null;
  canRead?: boolean;
  canShare?: boolean;
  expiresAt?: string | null;
}

export interface Authorizer {
  canRead(file: FileRecord, ctx: FileProviderContext): Promise<boolean>;
  canWrite(file: FileRecord, ctx: FileProviderContext): Promise<boolean>;
  canDelete(file: FileRecord, ctx: FileProviderContext): Promise<boolean>;
}

export interface FileServiceConfig {
  db: Adapter;
  storage: StorageAdapter;
  policies?: Pick<PolicyRegistry, 'get'>;
  events: FileFnEventEmitter;
  logger?: Logger;
  quota?: QuotaProvider;
  authorizer?: Authorizer;
  namespace?: string;
  signedUrlTtlSeconds?: number;
  /** The database the host passed, before FileFn's wrappers (default `db`); see `createFileCommitLock`. */
  databaseIdentity?: object;
}

interface CursorTuple {
  updatedAt: string;
  fileId: string;
}

export type FileReadResult = FileRecord & {
  versionId?: string;
  versionCreatedAt?: string;
  checksumSha256Base64?: string | null;
  storageKey?: string;
};

type RenderIntent = 'thumbnail' | 'preview' | 'full' | 'download';
type RenderState = 'ready' | 'processing' | 'pending-local' | 'unsupported';
type RenderPlaceholderKind = 'generic-file' | 'pdf-processing' | 'unsupported-preview';

interface RenderDescriptor {
  fileId: string;
  versionId: string;
  intent: RenderIntent;
  state: RenderState;
  mimeType: string;
  name: string;
  size: number;
  source:
    | {
        mode: 'artifact';
        artifactId: string;
        artifactKind: string;
        url: string;
        headers?: Record<string, string>;
      }
    | {
        mode: 'original';
        url: string;
        headers?: Record<string, string>;
      }
    | {
        mode: 'placeholder';
        placeholderKind: RenderPlaceholderKind;
      };
  warnings?: string[];
}

function createDefaultAuthorizer(): Authorizer {
  return {
    async canRead(file, ctx) {
      if (file.visibility === 'public') return true;
      if (isFileOwner(file, ctx)) return true;
      if (file.visibility === 'shared' && file.tenantId && file.tenantId === ctx.tenantId) return true;
      return false;
    },
    async canWrite(file, ctx) {
      return isFileOwner(file, ctx);
    },
    async canDelete(file, ctx) {
      return isFileOwner(file, ctx);
    },
  };
}

function fileSortComparator(a: FileRecord, b: FileRecord): number {
  const aTs = Date.parse(a.updatedAt);
  const bTs = Date.parse(b.updatedAt);
  if (aTs !== bTs) {
    return bTs - aTs; // updatedAt DESC
  }
  return a.fileId.localeCompare(b.fileId); // fileId ASC
}

function encodeCursor(tuple: CursorTuple): string {
  return Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url');
}

function isAfterCursor(file: FileRecord, cursor: CursorTuple): boolean {
  const fileTs = Date.parse(file.updatedAt);
  const cursorTs = Date.parse(cursor.updatedAt);

  if (fileTs < cursorTs) return true;
  if (fileTs > cursorTs) return false;

  return file.fileId.localeCompare(cursor.fileId) > 0;
}


function tryParseCursor(cursor: string): CursorTuple | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorTuple>;
    if (typeof decoded.updatedAt === 'string' && typeof decoded.fileId === 'string') {
      return { updatedAt: decoded.updatedAt, fileId: decoded.fileId };
    }
  } catch {
    // Fall through for legacy/plain cursor support.
  }
  return null;
}

function proxyPartKey(storageKey: string, partNumber: number): string {
  return `${storageKey}.part${partNumber}`;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

function isPdfMimeType(mimeType: string): boolean {
  return mimeType === 'application/pdf';
}

function isMediaPreviewMimeType(mimeType: string): boolean {
  return mimeType.startsWith('audio/') || mimeType.startsWith('video/');
}

function selectArtifactByKind(
  artifacts: FileArtifactRecord[],
  preferredKinds: string[],
): FileArtifactRecord | null {
  for (const kind of preferredKinds) {
    const found = artifacts.find((artifact) => artifact.kind === kind);
    if (found) {
      return found;
    }
  }
  return null;
}

export function createFileService(config: FileServiceConfig) {
  const {
    db,
    storage,
    policies,
    events,
    logger,
    quota,
    authorizer = createDefaultAuthorizer(),
    namespace = 'filefn',
    signedUrlTtlSeconds = 900,
  } = config;

  async function getReadableGrantFileIds(ctx: FileProviderContext): Promise<Set<string>> {
    if (!ctx.principalId) {
      return new Set<string>();
    }

    const findMany = (db as Partial<Adapter>).findMany;
    if (typeof findMany !== 'function') {
      return new Set<string>();
    }

    const grants: FilePermissionGrantRecord[] = [];
    grants.push(...await findMany.call(db, {
      model: 'filePermissions',
      where: [{ field: 'userId', operator: 'eq', value: ctx.principalId }],
      namespace,
    }) as FilePermissionGrantRecord[]);
    if (ctx.tenantId) {
      grants.push(...await findMany.call(db, {
        model: 'filePermissions',
        where: [{ field: 'tenantId', operator: 'eq', value: ctx.tenantId }],
        namespace,
      }) as FilePermissionGrantRecord[]);
    }

    const readable = new Set<string>();
    for (const grant of grants) {
      if (!grant?.canRead || isGrantExpired(grant.expiresAt)) continue;
      if (
        grant.userId === ctx.principalId ||
        (grant.tenantId && grant.tenantId === ctx.tenantId)
      ) {
        readable.add(grant.fileId);
      }
    }

    return readable;
  }

  async function canReadFile(
    file: FileRecord,
    ctx: FileProviderContext,
    readableGrantFileIds?: Set<string>
  ): Promise<boolean> {
    if (await authorizer.canRead(file, ctx)) {
      return true;
    }

    if (readableGrantFileIds?.has(file.fileId)) {
      return true;
    }

    return false;
  }

  /** Deletes one stored object; a storage error (the object may already be gone) reports false. */
  async function deleteObjectBestEffort(ref: string): Promise<boolean> {
    try {
      await storage.deleteObject(parseStorageRef(ref));
      return true;
    } catch {
      return false;
    }
  }

  async function getVersionChecked(fileId: string, versionId: string): Promise<FileVersionRecord> {
    const version = await db.findOne<FileVersionRecord>({
      model: 'fileVersions',
      where: [{ field: 'versionId', operator: 'eq', value: versionId }],
      namespace,
    });

    if (!version) {
      throw errors.notFound('Version');
    }

    if (version.fileId !== fileId) {
      throw errors.notFound('Version');
    }

    return version;
  }

  async function getArtifactDownloadUrl(
    file: Pick<FileRecord, 'policy' | 'fileId'>,
    artifact: FileArtifactRecord,
  ): Promise<{ url: string; headers?: Record<string, string> }> {
    const artifactStorageTarget = resolveArtifactStorageTarget(policies?.get(file.policy) ?? {});
    if (getStorageCapabilities(storage, artifactStorageTarget).signedDownloadUrls && storage.signDownloadUrl) {
      const result = await storage.signDownloadUrl({
        key: artifact.storageKey,
        target: artifactStorageTarget,
        expiresInSeconds: signedUrlTtlSeconds,
        ...signedDownloadConstraints(artifact.mimeType),
      });
      return { url: result.url, headers: result.headers };
    }

    return { url: `/proxy/files/${file.fileId}/artifacts/${artifact.artifactId}/download` };
  }

  function createPlaceholderDescriptor(input: {
    fileId: string;
    versionId: string;
    intent: RenderIntent;
    state: 'processing' | 'unsupported';
    mimeType: string;
    name: string;
    size: number;
    placeholderKind: RenderPlaceholderKind;
    warnings?: string[];
  }): RenderDescriptor {
    return {
      fileId: input.fileId,
      versionId: input.versionId,
      intent: input.intent,
      state: input.state,
      mimeType: input.mimeType,
      name: input.name,
      size: input.size,
      source: {
        mode: 'placeholder',
        placeholderKind: input.placeholderKind,
      },
      warnings: input.warnings,
    };
  }

  const importObject = createImportObject({
    db, storage, policies, quota, logger, namespace, databaseIdentity: config.databaseIdentity,
  });

  return {
    /**
     * Registers an object already in storage as a new file and version without
     * copying it, after a HEAD confirms it exists with the given size. A trusted
     * server-side API (no route, no authorization context): the caller decides
     * the owner. Idempotent per object; see `ImportObjectInput`.
     */
    importObject,

    async getFile(fileId: string, ctx: FileProviderContext, versionId?: string): Promise<FileReadResult> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        throw errors.notFound('File');
      }

      const readableGrantFileIds = await getReadableGrantFileIds(ctx);
      const canRead = await canReadFile(file, ctx, readableGrantFileIds);
      if (!canRead) {
        throw errors.forbidden();
      }

      if (!versionId) {
        return file;
      }

      const version = await getVersionChecked(fileId, versionId);

      return {
        ...file,
        currentVersionId: version.versionId,
        mimeType: version.mimeType,
        size: version.size,
        versionId: version.versionId,
        versionCreatedAt: version.createdAt,
        checksumSha256Base64: version.checksumSha256Base64,
        storageKey: version.storageKey,
      };
    },

    async listFiles(ctx: FileProviderContext, options: { cursor?: string; limit?: number } = {}): Promise<{
      files: FileRecord[];
      nextCursor?: string;
    }> {
      const requested = typeof options.limit === 'number' && Number.isFinite(options.limit)
        ? Math.floor(options.limit)
        : 20;
      const limit = Math.min(100, Math.max(1, requested));

      const allFiles = await db.findMany<FileRecord>({
        model: 'files',
        where: [],
        namespace,
      });

      const readableGrantFileIds = await getReadableGrantFileIds(ctx);
      const readableFiles: FileRecord[] = [];
      for (const file of allFiles) {
        if (await canReadFile(file, ctx, readableGrantFileIds)) {
          readableFiles.push(file);
        }
      }

      readableFiles.sort(fileSortComparator);

      let paged = readableFiles;
      if (options.cursor) {
        const tupleCursor = tryParseCursor(options.cursor);
        if (tupleCursor) {
          paged = readableFiles.filter((file) => isAfterCursor(file, tupleCursor));
        } else {
          // Legacy cursor support: plain fileId cursor from previous implementation.
          const legacyAnchor = readableFiles.find((file) => file.fileId === options.cursor);
          if (legacyAnchor) {
            const legacyTuple: CursorTuple = {
              updatedAt: legacyAnchor.updatedAt,
              fileId: legacyAnchor.fileId,
            };
            paged = readableFiles.filter((file) => isAfterCursor(file, legacyTuple));
          }
        }
      }

      const files = paged.slice(0, limit);
      const hasMore = paged.length > limit;

      return {
        files,
        nextCursor: hasMore && files.length > 0
          ? encodeCursor({ updatedAt: files[files.length - 1].updatedAt, fileId: files[files.length - 1].fileId })
          : undefined,
      };
    },

    async getDownloadUrl(fileId: string, versionId: string | undefined, ctx: FileProviderContext): Promise<{
      url: string;
      headers?: Record<string, string>;
    }> {
      const file = await this.getFile(fileId, ctx);
      const targetVersionId = versionId || file.currentVersionId;
      const version = await getVersionChecked(fileId, targetVersionId);
      const storageTarget = resolveStorageTarget(policies?.get(file.policy) ?? {});

      if (getStorageCapabilities(storage, storageTarget).signedDownloadUrls && storage.signDownloadUrl) {
        const result = await storage.signDownloadUrl({
          key: version.storageKey,
          target: storageTarget,
          expiresInSeconds: signedUrlTtlSeconds,
          ...signedDownloadConstraints(version.mimeType),
        });
        return { url: result.url, headers: result.headers };
      }

      const proxyUrl = versionId
        ? `/proxy/files/${fileId}/versions/${versionId}/download`
        : `/proxy/files/${fileId}/download`;

      return { url: proxyUrl };
    },

    async getDownloadStream(fileId: string, versionId: string | undefined, ctx: FileProviderContext): Promise<{
      stream: ReadableStream;
      contentType: string;
      size: number;
      fileName: string;
    }> {
      const file = await this.getFile(fileId, ctx);
      const targetVersionId = versionId || file.currentVersionId;
      const version = await getVersionChecked(fileId, targetVersionId);
      const storageTarget = resolveStorageTarget(policies?.get(file.policy) ?? {});

      if (!storage.openDownloadStream) {
        throw new Error('Storage adapter does not support streaming');
      }

      const stream = await storage.openDownloadStream({ key: version.storageKey, target: storageTarget });
      return {
        stream: stream as unknown as ReadableStream,
        contentType: version.mimeType,
        size: version.size,
        fileName: file.name,
      };
    },

    async getRenderDescriptor(
      fileId: string,
      options: { intent: RenderIntent; versionId?: string },
      ctx: FileProviderContext,
    ): Promise<RenderDescriptor> {
      const file = await this.getFile(fileId, ctx);
      const versionId = options.versionId || file.currentVersionId;
      const version = await getVersionChecked(fileId, versionId);
      const artifacts = await db.findMany<FileArtifactRecord>({
        model: 'fileArtifacts',
        where: [
          { field: 'fileId', operator: 'eq', value: fileId },
          { field: 'versionId', operator: 'eq', value: versionId },
        ],
        namespace,
      });

      // Thumbnails and previews must render in the browser: only inline-safe
      // raster artifacts qualify, whatever their kind says.
      // A guest (no principal, or the shared 'anonymous' one) reads artifacts
      // of public files only, as the artifact routes do, so a descriptor never
      // names an artifact URL its proxy would refuse.
      const guestOnPrivate = (!ctx.principalId || ctx.principalId === 'anonymous') && file.visibility !== 'public';
      const previewArtifacts = (guestOnPrivate ? [] : artifacts).filter(
        (artifact) => contentTypeEssence(artifact.mimeType).startsWith('image/') && isInlineSafeContentType(artifact.mimeType),
      );

      const originalDescriptor = async (): Promise<RenderDescriptor> => {
        const original = await this.getDownloadUrl(fileId, versionId, ctx);
        return {
          fileId,
          versionId,
          intent: options.intent,
          state: 'ready',
          mimeType: version.mimeType,
          name: file.name,
          size: version.size,
          source: {
            mode: 'original',
            url: original.url,
            headers: original.headers,
          },
        };
      };

      const artifactDescriptor = async (artifact: FileArtifactRecord): Promise<RenderDescriptor> => {
        const resolved = await getArtifactDownloadUrl(file, artifact);
        return {
          fileId,
          versionId,
          intent: options.intent,
          state: 'ready',
          mimeType: artifact.mimeType,
          name: file.name,
          size: artifact.size ?? version.size,
          source: {
            mode: 'artifact',
            artifactId: artifact.artifactId,
            artifactKind: artifact.kind,
            url: resolved.url,
            headers: resolved.headers,
          },
        };
      };

      if (options.intent === 'full' || options.intent === 'download') {
        return originalDescriptor();
      }

      const placeholder = (
        state: 'unsupported' | 'processing',
        placeholderKind: RenderPlaceholderKind,
        warnings?: string[],
      ): RenderDescriptor =>
        createPlaceholderDescriptor({
          fileId,
          versionId,
          intent: options.intent,
          state,
          mimeType: version.mimeType,
          name: file.name,
          size: version.size,
          placeholderKind,
          ...(warnings ? { warnings } : {}),
        });
      // An image: its preview artifact, else the original when it renders
      // inline; SVG and other images served only as downloads get no preview.
      const imagePreview = (kinds: string[], unsupportedKind: 'generic-file' | 'unsupported-preview') => {
        const artifact = selectArtifactByKind(previewArtifacts, kinds);
        if (artifact) return artifactDescriptor(artifact);
        if (isInlineSafeContentType(version.mimeType)) return originalDescriptor();
        return placeholder('unsupported', unsupportedKind);
      };
      const pdfPreview = (kinds: string[]) => {
        const artifact = selectArtifactByKind(previewArtifacts, kinds);
        if (artifact) return artifactDescriptor(artifact);
        // A guest is never shown a private file's preview: not "processing",
        // which a UI would poll forever.
        if (guestOnPrivate) return placeholder('unsupported', 'generic-file');
        return placeholder('processing', 'pdf-processing', ['PDF preview artifact is not available yet.']);
      };

      if (options.intent === 'thumbnail') {
        if (isImageMimeType(version.mimeType)) return imagePreview(['thumbnail-small', 'thumbnail-medium'], 'generic-file');
        if (isPdfMimeType(version.mimeType)) return pdfPreview(['pdf-preview-page-1-small', 'pdf-preview-page-1-medium']);
        return placeholder('unsupported', 'generic-file');
      }

      if (isImageMimeType(version.mimeType)) return imagePreview(['thumbnail-large'], 'unsupported-preview');
      if (isPdfMimeType(version.mimeType)) return pdfPreview(['pdf-preview-page-1-large', 'pdf-preview-page-1-medium']);

      // Only media the browser may play from the original (it is otherwise
      // served as a download).
      if (isMediaPreviewMimeType(version.mimeType) && isInlineSafeContentType(version.mimeType)) {
        return originalDescriptor();
      }

      return placeholder('unsupported', 'unsupported-preview');
    },

    async deleteFile(fileId: string, ctx: FileProviderContext): Promise<void> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        throw errors.notFound('File');
      }

      const canDelete = await authorizer.canDelete(file, ctx);
      if (!canDelete) {
        throw errors.forbidden();
      }

      // A refused session may still have objects to delete; its row is that
      // record, so refused sessions are left to the expiry sweep, which finishes
      // the cleanup. A session a completion holds ('completing') or is
      // publishing may be writing the file and its versions: the delete waits
      // for it (409, retryable) and never touches it. Every other open session
      // is ended (aborted) first, with a write conditional on the status read
      // here, so one a completion claims meanwhile is never torn down: the
      // delete then gets 409 too.
      const openSessionsWhere: WhereClause[] = [
        { field: 'fileId', operator: 'eq', value: fileId },
        { field: 'status', operator: 'ne', value: 'completed' },
        { field: 'status', operator: 'ne', value: 'refused' },
        { field: 'status', operator: 'ne', value: 'completing' },
        { field: 'status', operator: 'ne', value: 'publishing' },
      ];
      const unfinishedSessions = await db.findMany<UploadSessionRecord>({
        model: 'uploadSessions',
        where: [
          { field: 'fileId', operator: 'eq', value: fileId },
          { field: 'status', operator: 'ne', value: 'completed' },
        ],
        namespace,
      });
      if (unfinishedSessions.some((session) => session.status === 'completing' || session.status === 'publishing')) {
        throw errors.uploadCompletionInProgress();
      }
      const pendingSessions: UploadSessionRecord[] = [];
      for (const session of unfinishedSessions) {
        if (session.status === 'refused') continue;
        const sessionWhere: WhereClause[] = [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }];
        let ended: unknown;
        try {
          ended = await db.update({
            model: 'uploadSessions',
            where: [...sessionWhere, { field: 'status', operator: 'eq', value: session.status }],
            data: { status: 'aborted' },
            namespace,
          });
        } catch {
          ended = undefined;
        }
        if (!ended) {
          const current = await db.findOne<UploadSessionRecord>({ model: 'uploadSessions', where: sessionWhere, namespace });
          if (current?.status === 'refused' || !current) continue;
          if (current.status !== 'aborted') throw errors.uploadCompletionInProgress();
        }
        pendingSessions.push(session);
      }

      // A completion call of a completed session may still be finishing its
      // publication (it overlapped the call that completed it) and create a
      // files or version row this delete removes. Each such call checks this
      // mark after creating a row, and removes the row again. Right before the
      // file row is deleted (below, after every other step of the delete), the
      // claim records the session for the expiry sweep, which removes a row
      // such a call left; a retry after a failed delete records every session
      // an earlier attempt marked too.
      const completedSessions = await db.findMany<UploadSessionRecord>({
        model: 'uploadSessions',
        where: [
          { field: 'fileId', operator: 'eq', value: fileId },
          { field: 'status', operator: 'eq', value: 'completed' },
        ],
        namespace,
      });
      const markedSessions: UploadSessionRecord[] = [];
      for (const session of completedSessions) {
        const publication = session.completionPublication;
        if (!publication || publication.fileDeletedAt) continue;
        markedSessions.push(session);
        if (publication.fileDeleted) continue;
        await db.update({
          model: 'uploadSessions',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
          data: { completionPublication: { ...publication, fileDeleted: true } },
          namespace,
        });
      }

      // Read only now: no completion can publish a version of the file any
      // more (none is completing or publishing, and every open session ended).
      const versions = await db.findMany<FileVersionRecord>({
        model: 'fileVersions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      for (const session of pendingSessions) {
        const sessionPolicy = policies?.get(session.policy) ?? {};
        const sessionStorageTarget = resolveStorageTarget(sessionPolicy);
        if (session.storageUploadId && storage.abortMultipartUpload) {
          try {
            await storage.abortMultipartUpload({
              key: session.storageKey,
              target: sessionStorageTarget,
              uploadId: session.storageUploadId,
            });
          } catch {
            // Best-effort abort for stale multipart uploads.
          }
        }

        const parts = await db.findMany<UploadPartRecord>({
          model: 'uploadParts',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
          select: ['partNumber'],
          namespace,
        });

        if (session.uploadMode === 'proxy') {
          for (const part of parts) {
            try {
              await storage.deleteObject({ key: proxyPartKey(session.storageKey, part.partNumber), target: sessionStorageTarget });
            } catch {
              // Best-effort cleanup for proxy temp parts.
            }
          }
        }

        await db.deleteMany({
          model: 'uploadParts',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
          namespace,
        });
      }

      await db.deleteMany({
        model: 'filePermissions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      await db.deleteMany({
        model: 'fileShares',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      // Retry-safe order. Everything the version objects need (their refs, the
      // bytes they free and the refs other files hold) is read before the version
      // rows go, and the objects are removed and their quota released right after.
      // A failure in any later step leaves the artifact rows and the file row in
      // place, so a retry still finds and removes them.
      //
      // Versions go before artifacts are listed. A queued processing job checks
      // its version after writing, so an artifact it writes before the version
      // removal is in the list below, and one it writes later is removed by the job.
      const filePolicy = policies?.get(file.policy) ?? {};
      const fileStorageTarget = resolveStorageTarget(filePolicy);
      const artifactStorageTarget = resolveArtifactStorageTarget(filePolicy);
      const versionBytesByStorageRef = new Map<string, number>();
      for (const version of versions) {
        const ref = storageRef(fileStorageTarget, version.storageKey);
        const existing = versionBytesByStorageRef.get(ref) ?? 0;
        versionBytesByStorageRef.set(ref, Math.max(existing, version.size));
      }
      const versionRefsReferencedElsewhere = await findReferencedStorageRefs(
        { db, namespace, policies },
        new Set(versionBytesByStorageRef.keys()),
        { fileId },
      );

      await db.deleteMany({
        model: 'fileVersions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      let totalBytesFreed = 0;
      for (const [ref, bytes] of versionBytesByStorageRef) {
        if (versionRefsReferencedElsewhere.has(ref)) {
          continue;
        }
        if (await deleteObjectBestEffort(ref)) {
          totalBytesFreed += bytes;
        }
      }

      if (quota && totalBytesFreed > 0) {
        await quota.recordUsage({
          // The reserved owner 'anonymous' is the provider's unset principal,
          // the account its uploads were charged to.
          principalId: file.ownerId && file.ownerId !== 'anonymous' ? file.ownerId : undefined,
          tenantId: file.tenantId ?? undefined,
          bytes: -totalBytesFreed,
        });
      }

      const artifacts = await db.findMany<FileArtifactRecord>({
        model: 'fileArtifacts',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      // A client object is deleted where its row recorded storing it; a
      // server artifact row's object is where reads find it, by policy. A
      // server object no row names any more is never deleted here, and its
      // record stays: its key is a processor's, which another file may publish
      // again between any reference check and a delete, so reclaiming it needs
      // coordination with publishers that file deletion does not have.
      const displacedServerObject = (artifact: FileArtifactRecord) =>
        artifact.kind === DISPLACED_OBJECT_KIND && artifactSourceOf(artifact) !== 'client';
      const refOf = (artifact: FileArtifactRecord) => storageRef(
        (artifactSourceOf(artifact) === 'client' ? recordedStorageTarget(artifact) : undefined) ?? artifactStorageTarget,
        artifact.storageKey,
      );
      const artifactStorageRefs = new Set<string>();
      for (const artifact of artifacts) {
        if (artifact.kind !== PROCESSING_RUN_KIND && !displacedServerObject(artifact)) {
          artifactStorageRefs.add(refOf(artifact));
        }
      }

      const artifactRefsReferencedElsewhere = await findReferencedStorageRefs(
        { db, namespace, policies },
        artifactStorageRefs,
        { fileId },
      );

      // A client object's key is its upload's alone, so the record of one
      // stays until `cleanupOrphanedArtifacts` confirms its delete, whatever
      // happens to the deletes below or to a concurrent upload's: each client
      // artifact row becomes such a record, and upload and displaced-object
      // records stay.
      const clientRowIds = artifacts
        .filter((artifact) => artifactSourceOf(artifact) === 'client' && !RECORD_KINDS.includes(artifact.kind))
        .map((artifact) => artifact.artifactId);
      if (clientRowIds.length > 0) {
        await db.updateMany({
          model: 'fileArtifacts',
          where: [{ field: 'artifactId', operator: 'in', value: clientRowIds }],
          data: { kind: DISPLACED_OBJECT_KIND },
          namespace,
        });
      }
      await db.deleteMany({
        model: 'fileArtifacts',
        where: [
          { field: 'fileId', operator: 'eq', value: fileId },
          { field: 'kind', operator: 'not_in', value: RECORD_KINDS },
        ],
        namespace,
      });
      await db.deleteMany({
        model: 'uploadSessions',
        where: openSessionsWhere,
        namespace,
      });

      for (const session of markedSessions) {
        await db.update({
          model: 'uploadSessions',
          where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
          data: {
            completionClaim: FILE_DELETED_CLAIM,
            completionPublication: { ...session.completionPublication, fileDeleted: true, fileDeletedAt: new Date().toISOString() },
          },
          namespace,
        });
      }
      await db.delete({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      for (const ref of artifactStorageRefs) {
        if (!artifactRefsReferencedElsewhere.has(ref)) {
          await deleteObjectBestEffort(ref);
        }
      }

      events.emit('file:deleted', createFileDeletedEvent({
        fileId,
        ownerId: file.ownerId,
        tenantId: file.tenantId || undefined,
      }, ctx.requestId));

      logger?.info('File deleted', {
        fileId,
        ownerId: file.ownerId,
        tenantId: file.tenantId,
        requestId: ctx.requestId,
      });
    },

    async listVersions(
      fileId: string,
      ctx: FileProviderContext,
      page?: { limit?: number; offset?: number },
    ): Promise<{ versions: FileVersionRecord[] }> {
      await this.getFile(fileId, ctx);

      const versions = await db.findMany<FileVersionRecord>({
        model: 'fileVersions',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        orderBy: [
          { field: 'createdAt', direction: 'desc' },
          { field: 'versionId', direction: 'desc' },
        ],
        limit: page?.limit,
        offset: page?.offset,
        namespace,
      });

      return { versions };
    },

    /** Whether the principal may read an existing file: the authorizer or a read grant. Missing files read as false. */
    async canReadFile(fileId: string, ctx: FileProviderContext): Promise<boolean> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });
      if (!file) {
        return false;
      }
      return canReadFile(file, ctx, await getReadableGrantFileIds(ctx));
    },

    async canWriteFile(fileId: string, ctx: FileProviderContext): Promise<boolean> {
      const file = await db.findOne<FileRecord>({
        model: 'files',
        where: [{ field: 'fileId', operator: 'eq', value: fileId }],
        namespace,
      });

      if (!file) {
        return true;
      }

      return authorizer.canWrite(file, ctx);
    },

    async getVersion(fileId: string, versionId: string, ctx: FileProviderContext): Promise<FileVersionRecord & { fileId: string }> {
      await this.getFile(fileId, ctx);
      const version = await getVersionChecked(fileId, versionId);
      return { ...version, fileId };
    },

    async getDownloadUrlWithBinding(fileId: string, versionId: string, ctx: FileProviderContext): Promise<{
      url: string;
      headers?: Record<string, string>;
    }> {
      return this.getDownloadUrl(fileId, versionId, ctx);
    },
  };
}

export type FileService = ReturnType<typeof createFileService>;
