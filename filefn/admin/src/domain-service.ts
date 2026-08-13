import type {
  FileFn,
  FileArtifactRecord,
  Policy,
} from "@filefn/server";
import {
  AdminError,
  decodeAdminCursor,
  encodeAdminCursor,
  normalizeAdminPageLimit,
  type AdminOperationContext,
  type AdminOperationResult,
} from "@superfunctions/admin";
import type {
  FileFnAdminOperationId,
  FileFnAdminOperationInputMap,
  FileFnAdminOperationOutputMap,
  FileFnAdminService,
  FileFnAdminServiceMethod,
  PageInput,
} from "./index.js";

type JsonRecord = Record<string, unknown>;
type FileFnDomainRequest = {
  [K in FileFnAdminOperationId]: {
    operationId: K;
    input: FileFnAdminOperationInputMap[K];
    context: AdminOperationContext;
  }
}[FileFnAdminOperationId];

export interface FileFnDomainContext {
  principalId?: string;
  tenantId?: string;
  requestId?: string;
}

export interface FileFnDomainAdminServiceOptions {
  /** Public FileFn facade and its bound service bundle. */
  fileFn: FileFn;
  /** Maps the active admin actor/scope to FileFn's principal and tenant identity. */
  context(admin: AdminOperationContext): FileFnDomainContext;
}

function domainContext(options: FileFnDomainAdminServiceOptions, admin: AdminOperationContext): FileFnDomainContext & { principalId: string } {
  const mapped = options.context(admin);
  const principalId = mapped.principalId;
  if (!principalId) {
    throw new AdminError("invalid_argument", "FileFn administration requires a mapped principalId.");
  }
  return { ...mapped, principalId, requestId: mapped.requestId ?? admin.requestId };
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminError("internal", `${label} returned an invalid domain object.`);
  }
  return value as JsonRecord;
}

function item(value: object): AdminOperationResult<JsonRecord> {
  return { ok: true, data: { item: { ...value } } };
}

function accepted(value?: object): AdminOperationResult<JsonRecord> {
  return { ok: true, data: { accepted: true, ...(value ? { item: { ...value } } : {}) } };
}

function page<T extends object>(values: readonly T[], input: PageInput, admin: AdminOperationContext): AdminOperationResult<JsonRecord> {
  const limit = normalizeAdminPageLimit(input.limit, { defaultLimit: 50, maxLimit: 100 });
  const offset = input.cursor ? decodeAdminCursor<{ offset: number }>(input.cursor, admin.scope).offset : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AdminError("invalid_argument", "The FileFn admin cursor is invalid.");
  }
  const items = values.slice(offset, offset + limit).map((value) => ({ ...value }));
  const nextOffset = offset + items.length;
  const nextCursor = nextOffset < values.length ? encodeAdminCursor(admin.scope, { offset: nextOffset }) : null;
  return { ok: true, data: { items, nextCursor }, page: { nextCursor, hasMore: nextOffset < values.length } };
}

function safeVersion(value: JsonRecord): JsonRecord {
  const { storageKey: _storageKey, ...safe } = value;
  return safe;
}

function safeArtifact(value: FileArtifactRecord): JsonRecord {
  const { storageKey: _storageKey, ...safe } = value;
  return safe;
}

function safePolicy(value: Policy): JsonRecord {
  const { storagePath, ...safe } = value;
  return { ...safe, customStoragePath: Boolean(storagePath) };
}

function findById<T extends object>(values: readonly T[], predicate: (value: T) => boolean, label: string): T {
  const value = values.find(predicate);
  if (!value) throw new AdminError("not_found", `${label} was not found in the active FileFn project.`);
  return value;
}

/**
 * Binds the administration capability to FileFn's public domain services. The
 * adapter never reads FileFn tables directly, so owner/tenant authorization,
 * policy validation, quotas, storage routing, lifecycle cleanup, and events
 * remain enforced by FileFn itself.
 */
export function createFileFnDomainAdminService(options: FileFnDomainAdminServiceOptions): FileFnAdminService {
  const { files, grants, shares, processing, policies } = options.fileFn.services;
  const execute = async (request: FileFnDomainRequest): Promise<AdminOperationResult<JsonRecord>> => {
      const ctx = domainContext(options, request.context);

      switch (request.operationId) {
        case "filefn.files.list": {
          const result = record(await options.fileFn.listFiles(request.input, ctx), "FileFn.listFiles");
          const files = Array.isArray(result.files) ? result.files : [];
          const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
          return { ok: true, data: { items: files, nextCursor }, page: { nextCursor, hasMore: nextCursor !== null } };
        }
        case "filefn.files.get":
          return item(record(await options.fileFn.getFile({ fileId: request.input.id }, ctx), "FileFn.getFile"));
        case "filefn.files.download":
          return item(await files.getDownloadUrl(request.input.id, request.input.versionId, ctx));
        case "filefn.files.delete-file":
          await options.fileFn.deleteFile({ fileId: request.input.id }, ctx);
          return accepted();
        case "filefn.versions.list": {
          const result = await files.listVersions(request.input.fileId, ctx);
          return page(result.versions.map((version) => safeVersion({ ...version })), request.input, request.context);
        }
        case "filefn.versions.get":
          return item(safeVersion({ ...await files.getVersion(request.input.fileId, request.input.id, ctx) }));
        case "filefn.upload-sessions.get": {
          const uploadCtx = { ...ctx, ...(request.input.uploadSessionToken ? { uploadSessionToken: request.input.uploadSessionToken } : {}) };
          return item(record(await options.fileFn.getUploadSessionStatus({ uploadSessionId: request.input.id }, uploadCtx), "FileFn.getUploadSessionStatus"));
        }
        case "filefn.upload-sessions.create-upload": {
          const result = await options.fileFn.createUploadSession({ ...request.input, idempotencyKey: request.context.idempotencyKey }, ctx);
          return accepted(result);
        }
        case "filefn.upload-sessions.complete-upload": {
          const uploadCtx = { ...ctx, ...(request.input.uploadSessionToken ? { uploadSessionToken: request.input.uploadSessionToken } : {}) };
          return accepted(await options.fileFn.completeUploadSession({ uploadSessionId: request.input.id }, uploadCtx));
        }
        case "filefn.upload-sessions.abort-upload": {
          const uploadCtx = { ...ctx, ...(request.input.uploadSessionToken ? { uploadSessionToken: request.input.uploadSessionToken } : {}) };
          await options.fileFn.abortUploadSession({ uploadSessionId: request.input.id }, uploadCtx);
          return accepted();
        }
        case "filefn.grants.list":
          return page(await grants.listGrants(request.input.fileId, ctx), request.input, request.context);
        case "filefn.grants.create-grant":
          return accepted(await grants.createGrant(request.input, ctx));
        case "filefn.grants.revoke-grant":
          await grants.revokeGrant(request.input.fileId, request.input.id, ctx);
          return accepted();
        case "filefn.share-links.list":
          return page(await shares.listShareLinks(request.input.fileId, ctx), request.input, request.context);
        case "filefn.share-links.create-share":
          return accepted(await shares.createShareLink(request.input, ctx));
        case "filefn.share-links.revoke-share":
          await shares.revokeShareLink(request.input.fileId, request.input.token, ctx);
          return accepted();
        case "filefn.policies.list":
          return page(policies.list().map(safePolicy), request.input, request.context);
        case "filefn.policies.get": {
          const policy = policies.get(request.input.id);
          if (!policy) throw new AdminError("not_found", "Policy was not found in the active FileFn project.");
          return item(safePolicy(policy));
        }
        case "filefn.artifacts.list":
          return page((await processing.listArtifactsForFile(request.input.fileId, ctx)).map(safeArtifact), request.input, request.context);
        case "filefn.artifacts.get": {
          const artifacts = await processing.listArtifactsForFile(request.input.fileId, ctx);
          return item(safeArtifact(findById(artifacts, (value) => value.artifactId === request.input.id, "Artifact")));
        }
        case "filefn.artifacts.download":
          return item(await processing.getArtifactDownloadUrlForFile(request.input.fileId, request.input.id, ctx));
        case "filefn.artifacts.process-file": {
          const readable = await processing.getReadableVersionForFile(request.input.fileId, ctx, request.input.versionId);
          return accepted(await processing.triggerProcessing({
            fileId: readable.file.fileId,
            versionId: readable.version.versionId,
            storageKey: readable.version.storageKey,
            mimeType: readable.version.mimeType,
            size: readable.version.size,
            fileName: readable.file.name,
            tenantId: readable.file.tenantId ?? undefined,
          }, ctx));
        }
      }
    };

  const operation = <K extends FileFnAdminOperationId>(operationId: K): FileFnAdminServiceMethod<K> =>
    async (input, context) => execute({ operationId, input, context } as FileFnDomainRequest) as unknown as Promise<AdminOperationResult<FileFnAdminOperationOutputMap[K]>>;

  return {
    listFiles: operation("filefn.files.list"),
    getFile: operation("filefn.files.get"),
    downloadFile: operation("filefn.files.download"),
    deleteFile: operation("filefn.files.delete-file"),
    listVersions: operation("filefn.versions.list"),
    getVersion: operation("filefn.versions.get"),
    getUploadSession: operation("filefn.upload-sessions.get"),
    createUpload: operation("filefn.upload-sessions.create-upload"),
    completeUpload: operation("filefn.upload-sessions.complete-upload"),
    abortUpload: operation("filefn.upload-sessions.abort-upload"),
    listGrants: operation("filefn.grants.list"),
    createGrant: operation("filefn.grants.create-grant"),
    revokeGrant: operation("filefn.grants.revoke-grant"),
    listShareLinks: operation("filefn.share-links.list"),
    createShareLink: operation("filefn.share-links.create-share"),
    revokeShareLink: operation("filefn.share-links.revoke-share"),
    listPolicies: operation("filefn.policies.list"),
    getPolicy: operation("filefn.policies.get"),
    listArtifacts: operation("filefn.artifacts.list"),
    getArtifact: operation("filefn.artifacts.get"),
    downloadArtifact: operation("filefn.artifacts.download"),
    processFile: operation("filefn.artifacts.process-file"),
  };
}
