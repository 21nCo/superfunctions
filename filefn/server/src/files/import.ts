import { createHash } from 'node:crypto';
import type { Adapter } from '@superfunctions/db';
import type { StorageAdapter, StorageObjectStat } from '@superfunctions/storage';
import type { QuotaProvider } from '../upload-sessions/service.js';
import type { Logger } from '../observability/logger.js';
import { resolveStorageTarget, type PolicyRegistry } from '../policies.js';
import { isValidClientFileId } from '../upload-sessions/file-id.js';
import { createFileCommitLock, runFileFnSerialized } from './file-commit-lock.js';
import { storageRef } from '../storage-references.js';
import * as errors from '../errors.js';
import type { FileRecord, FileVersionRecord } from './service.js';

/** Policy recorded on an imported file when the caller names none. */
export const DEFAULT_IMPORT_POLICY = 'default';

export interface ImportObjectInput {
  /** Key of the object, already stored in the policy's storage target. */
  storageKey: string;
  /** Owner of the new file. */
  principalId: string;
  tenantId: string | null | undefined;
  /** File ID for the new file (client file ID grammar). Omitted: derived from the object. */
  fileId?: string;
  fileName: string;
  mimeType: string;
  /** Expected object size in bytes; the object's HEAD must report exactly this. */
  size: number;
  /** Creation time to keep (ISO 8601 string or Date). Omitted: now. */
  createdAt?: string | Date;
  metadata?: Record<string, unknown>;
  /**
   * Policy of the new file; it decides the storage target the object is read
   * from and the file's visibility. Omitted: `DEFAULT_IMPORT_POLICY`, which
   * resolves like any unregistered policy (default storage target, private).
   */
  policy?: string;
}

export interface ImportObjectResult {
  file: FileRecord;
  version: FileVersionRecord;
  /** False when this object had already been imported and the existing file is returned. */
  created: boolean;
}

export interface ImportObjectDeps {
  db: Adapter;
  storage: StorageAdapter;
  policies?: Pick<PolicyRegistry, 'get'>;
  quota?: QuotaProvider;
  logger?: Logger;
  namespace: string;
  /** The database the host passed, before FileFn's wrappers (default `db`). */
  databaseIdentity?: object;
}

/** Crockford base32, lowercase, as in `generateFileFnId`. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Stable `<prefix>_<20 base32 chars>` ID of one stored object (target and key),
 * the format `generateFileFnId` produces, so every import of the object names
 * the same version (and, without a caller file ID, the same file).
 */
function importId(prefix: 'file' | 'ver', ref: string): string {
  const digest = createHash('sha256').update(`filefn-import\u0000${prefix}\u0000${ref}`).digest();
  let suffix = '';
  for (let index = 0; index < 20; index += 1) {
    suffix += ALPHABET[digest[index] & 31];
  }
  return `${prefix}_${suffix}`;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw errors.invalidRequest(`${field} must be a non-empty string`, { field });
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

interface ParsedImport {
  storageKey: string;
  principalId: string;
  tenantId: string | null;
  fileId?: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt?: string;
  metadata: Record<string, unknown>;
  policy: string;
}

function parseImportInput(input: ImportObjectInput): ParsedImport {
  if (!isPlainObject(input)) {
    throw errors.invalidRequest('import input must be an object');
  }
  const storageKey = requireText(input.storageKey, 'storageKey');
  const principalId = requireText(input.principalId, 'principalId');
  const fileName = requireText(input.fileName, 'fileName');
  const mimeType = requireText(input.mimeType, 'mimeType');
  const tenantId = input.tenantId ?? null;
  if (tenantId !== null) requireText(tenantId, 'tenantId');
  if (input.fileId !== undefined && !isValidClientFileId(input.fileId)) {
    throw errors.invalidFileId();
  }
  if (typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size < 0) {
    throw errors.invalidRequest('size must be a non-negative integer', { field: 'size' });
  }
  let createdAt: string | undefined;
  if (input.createdAt !== undefined) {
    const parsed = input.createdAt instanceof Date
      ? input.createdAt.getTime()
      : typeof input.createdAt === 'string' ? Date.parse(input.createdAt) : Number.NaN;
    if (Number.isNaN(parsed)) {
      throw errors.invalidRequest('createdAt must be a valid date', { field: 'createdAt' });
    }
    createdAt = new Date(parsed).toISOString();
  }
  if (input.metadata !== undefined && !isPlainObject(input.metadata)) {
    throw errors.invalidRequest('metadata must be a plain object', { field: 'metadata' });
  }
  const policy = input.policy === undefined ? DEFAULT_IMPORT_POLICY : requireText(input.policy, 'policy');
  return {
    storageKey,
    principalId,
    tenantId,
    fileId: input.fileId,
    fileName,
    mimeType,
    size: input.size,
    createdAt,
    metadata: input.metadata ?? {},
    policy,
  };
}

function isStorageNotFound(error: unknown): boolean {
  const err = error as { code?: unknown; name?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  if (!err || typeof err !== 'object') return false;
  return err.code === 'STORAGE_NOT_FOUND'
    || err.code === 'ENOENT'
    || err.name === 'NotFound'
    || err.name === 'NoSuchKey'
    || err.statusCode === 404
    || err.$metadata?.httpStatusCode === 404;
}

const DUPLICATE_KEY_CODES = new Set<unknown>([
  '23505', // Postgres unique_violation
  'ER_DUP_ENTRY', // MySQL
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'P2002', // Prisma
  'ADAPTER_DUPLICATE_KEY', // @superfunctions/db DuplicateKeyError
]);

/**
 * Whether a failed insert was refused by a unique constraint, so it did not
 * write its row. Drivers' own errors are checked along the `cause` chain
 * (adapters and query builders wrap them).
 */
export function isDuplicateKeyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const err = current as { code?: unknown; errno?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (DUPLICATE_KEY_CODES.has(err.code) || err.errno === 1062 || err.name === 'DuplicateKeyError') return true;
    if (typeof err.message === 'string'
      && /duplicate key value violates unique constraint|UNIQUE constraint failed/i.test(err.message)) {
      return true;
    }
    current = err.cause;
  }
  return false;
}

/**
 * Builds `importObject`: registers an object already in storage as a new file
 * and version without copying it. See the FileFn server SDK docs ("Importing
 * existing objects") for the contract.
 *
 * Every import of one object (storage target and key) names the same version
 * ID, so the version row is the record that the object was imported: a rerun
 * finds it and returns the existing file, and of two imports racing on one
 * object only the first version insert succeeds. The `files` row is written
 * first, pointing at that version; a row left by an import interrupted before
 * its version insert is resumed by a rerun with the same file ID, and one left
 * by the loser of a race is removed by it (or by a later rerun of it).
 *
 * Within this process, imports of one object run one at a time (object key),
 * and the file ID claim runs under the per-fileId commit key upload completion
 * uses, so an import never creates a file another import or an upload is
 * creating with the same ID. On adapters without unique constraints these
 * keys are the only guard; with them, the unique `files.fileId` and
 * `fileVersions.versionId` constraints decide across processes.
 */
export function createImportObject(deps: ImportObjectDeps) {
  const { db, storage, policies, quota, logger, namespace } = deps;
  const lock = createFileCommitLock({ db, namespace, databaseIdentity: deps.databaseIdentity });
  // With unique constraints a stuck holder may be overtaken: the inserts still
  // let only one import create the file.
  const evictableAt = lock.uniqueConstraints ? 0 : undefined;

  const findFile = (fileId: string) => db.findOne<FileRecord>({
    model: 'files',
    where: [{ field: 'fileId', operator: 'eq', value: fileId }],
    namespace,
  });
  const findVersion = (versionId: string) => db.findOne<FileVersionRecord>({
    model: 'fileVersions',
    where: [{ field: 'versionId', operator: 'eq', value: versionId }],
    namespace,
  });
  // The reserved owner 'anonymous' is the provider's unset principal, as for
  // uploads, so a later delete refunds the same account the import charged.
  const recordUsage = (request: ParsedImport, bytes: number) => quota?.recordUsage({
    principalId: request.principalId && request.principalId !== 'anonymous' ? request.principalId : undefined,
    tenantId: request.tenantId ?? undefined,
    bytes,
  });

  /**
   * The file this object was already imported as. A `files` row of the caller's
   * file ID that points at the import version but lost it to another file
   * (a race loser interrupted before its cleanup) is removed.
   */
  async function existingImport(
    request: ParsedImport,
    fileId: string,
    version: FileVersionRecord,
  ): Promise<ImportObjectResult> {
    if (version.fileId !== fileId) {
      await db.deleteMany({
        model: 'files',
        where: [
          { field: 'fileId', operator: 'eq', value: fileId },
          { field: 'currentVersionId', operator: 'eq', value: version.versionId },
        ],
        namespace,
      });
    }
    const file = await findFile(version.fileId);
    if (!file) {
      // A delete of the file in progress leaves its version without it, and so
      // does a delete that interleaved an import of this object (a known gap,
      // FILE-14): imports of the object then fail until that row is removed.
      throw errors.notFound('File');
    }
    if (file.ownerId !== request.principalId || (file.tenantId ?? null) !== request.tenantId) {
      throw errors.importConflict(request.storageKey, 'owner');
    }
    return { file, version, created: false };
  }

  /**
   * Claims `fileId` for this import and publishes its version; runs under the
   * object key and the file ID's commit key.
   */
  async function claimAndPublish(
    request: ParsedImport,
    fileId: string,
    versionId: string,
    createdAt: string,
    visibility: FileRecord['visibility'],
  ): Promise<ImportObjectResult> {
    const raced = await findVersion(versionId);
    if (raced) return existingImport(request, fileId, raced);

    // A row of this file ID pointing at the import version was written by an
    // import of this object (an interrupted one, or a concurrent one with the
    // same file ID) and is resumed, for the same owner only; any other row is
    // another file (an upload's, or another object's import).
    const assertResumable = (row: FileRecord) => {
      if (row.currentVersionId !== versionId) {
        throw errors.importConflict(request.storageKey, 'fileId', fileId);
      }
      if (row.ownerId !== request.principalId || (row.tenantId ?? null) !== request.tenantId) {
        throw errors.importConflict(request.storageKey, 'owner');
      }
    };

    let file = await findFile(fileId);
    if (file) assertResumable(file);
    if (!file) {
      const data: FileRecord = {
        fileId,
        currentVersionId: versionId,
        ownerId: request.principalId,
        tenantId: request.tenantId,
        visibility,
        policy: request.policy,
        mimeType: request.mimeType,
        size: request.size,
        name: request.fileName,
        metadata: request.metadata,
        createdAt,
        updatedAt: createdAt,
      };
      try {
        file = (await db.create<FileRecord>({ model: 'files', data, namespace })) ?? data;
      } catch (err) {
        // Lost the insert to another writer of this file ID: re-read its row.
        file = await findFile(fileId);
        if (!file) throw err;
        assertResumable(file);
      }
    }

    // Usage is recorded before the version insert, so the version row also
    // records that it was: a rerun after a failed or interrupted record finds no
    // version and records it, and one after the insert records nothing. A failed
    // insert takes the record back only when it is known not to have written
    // its row (see `afterFailedInsert`); every other doubt keeps the record, so
    // usage is only ever over-counted, never lost.
    await recordUsage(request, request.size);
    const version: FileVersionRecord = {
      versionId,
      fileId,
      storageKey: request.storageKey,
      mimeType: request.mimeType,
      size: request.size,
      checksumSha256Base64: null,
      createdAt,
    };
    let created: FileVersionRecord;
    try {
      created = (await db.create<FileVersionRecord>({
        model: 'fileVersions',
        data: { ...version, tenantId: request.tenantId },
        namespace,
      })) ?? version;
    } catch (err) {
      return afterFailedInsert(request, fileId, versionId, err, file);
    }
    return { file, version: created, created: true };
  }

  /**
   * Settles a version insert that threw after this call recorded usage. The
   * insert is known not to have written its row when no row of the version
   * exists, when the row names another file (another import won the object),
   * or when the database refused the insert as a duplicate (an import in
   * another process with this file ID won). Only then is the record taken
   * back. A row of this file ID after any other error is this call's own
   * insert whose response was lost: the file is created, and its usage stays.
   */
  async function afterFailedInsert(
    request: ParsedImport,
    fileId: string,
    versionId: string,
    insertError: unknown,
    file: FileRecord,
  ): Promise<ImportObjectResult> {
    const found = await findVersion(versionId);
    if (found && found.fileId === fileId && !isDuplicateKeyError(insertError)) {
      return { file, version: found, created: true };
    }
    try {
      await recordUsage(request, -request.size);
    } catch (compensationError) {
      // The insert's error is the one to report. The bytes stay counted, as
      // after a stop between the record and the insert; a rerun that finds the
      // winner's version records nothing more.
      logger?.warn('Import usage could not be taken back after a failed version insert', {
        storageKey: request.storageKey,
        fileId,
        size: request.size,
        error: compensationError instanceof Error ? compensationError.message : String(compensationError),
      });
      throw insertError;
    }
    if (!found) throw insertError;
    return existingImport(request, fileId, found);
  }

  return async function importObject(input: ImportObjectInput): Promise<ImportObjectResult> {
    const request = parseImportInput(input);
    const registered = policies?.get(request.policy);
    if (input.policy !== undefined && !registered) {
      throw errors.policyNotFound(request.policy);
    }
    const target = resolveStorageTarget(registered ?? {});
    const ref = storageRef(target, request.storageKey);
    const versionId = importId('ver', ref);
    const fileId = request.fileId ?? importId('file', ref);

    const imported = await findVersion(versionId);
    if (imported) return existingImport(request, fileId, imported);

    let stat: StorageObjectStat;
    try {
      stat = await storage.statObject({ key: request.storageKey, target });
    } catch (err) {
      if (isStorageNotFound(err)) throw errors.importObjectNotFound(request.storageKey);
      throw err;
    }
    if (stat.size !== request.size) {
      throw errors.importSizeMismatch(request.storageKey, request.size, stat.size);
    }

    const createdAt = request.createdAt ?? new Date().toISOString();
    const visibility = registered?.visibility ?? 'private';
    // Keys: the object's, then the file ID's (upload completion never holds a
    // file key while waiting for another key, so the order cannot deadlock).
    const outcome = await runFileFnSerialized(
      `import\u0000${lock.scope}\u0000${versionId}`,
      () => runFileFnSerialized(
        lock.fileKey(fileId),
        () => claimAndPublish(request, fileId, versionId, createdAt, visibility),
        lock.importOptions(evictableAt),
      ),
      { evictableAt, keepWaiting: true },
    );

    if (outcome.created) {
      logger?.info('Storage object imported', {
        fileId: outcome.file.fileId,
        versionId,
        size: request.size,
      });
    }
    return outcome;
  };
}
