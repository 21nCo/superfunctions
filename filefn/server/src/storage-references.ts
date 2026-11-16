import type { Adapter } from '@superfunctions/db';
import { resolveArtifactStorageTarget, resolveStorageTarget, type PolicyRegistry } from './policies.js';
import { DISPLACED_OBJECT_KIND, PROCESSING_RUN_KIND, UPLOAD_INTENT_KIND, recordedStorageTarget } from './processing/service.js';

/** Read at call time: this module and the processing service import each other. */
function referencesNothing(kind: string): boolean {
  return kind === PROCESSING_RUN_KIND || kind === DISPLACED_OBJECT_KIND || kind === UPLOAD_INTENT_KIND;
}

/**
 * One stored object: the same key in two storage targets is two objects, so
 * every reference check compares the target and the key.
 */
export function storageRef(target: string, key: string): string {
  return `${target}\u0000${key}`;
}

export function parseStorageRef(ref: string): { target: string; key: string } {
  const split = ref.indexOf('\u0000');
  return { target: ref.slice(0, split), key: ref.slice(split + 1) };
}

export interface StorageReferenceLookup {
  db: Adapter;
  namespace: string;
  policies?: Pick<PolicyRegistry, 'get'>;
}

/**
 * Returns the refs among `candidates` that a `fileVersions` or `fileArtifacts`
 * row still references; a processing run row stores no object, and a record of
 * an object no row names (displaced, or an upload's own) is not read from, so
 * neither references anything. Each row's target comes from its file's policy: the storage target
 * for a version, the artifact storage target for an artifact. An artifact row
 * that recorded another target references the object there too, since the
 * policy may have changed since it was stored.
 * Rows of the `exclude` file are ignored; with a `versionId`, only that
 * version's rows are.
 */
export async function findReferencedStorageRefs(
  lookup: StorageReferenceLookup,
  candidates: ReadonlySet<string>,
  exclude?: { fileId: string; versionId?: string },
): Promise<Set<string>> {
  const { db, namespace, policies } = lookup;
  const referenced = new Set<string>();
  if (candidates.size === 0) {
    return referenced;
  }

  const isExcluded = (row: { fileId: string; versionId: string }) =>
    exclude !== undefined &&
    row.fileId === exclude.fileId &&
    (exclude.versionId === undefined || row.versionId === exclude.versionId);

  const allVersions = await db.findMany<{ fileId: string; versionId: string; storageKey: string }>({
    model: 'fileVersions',
    where: [],
    select: ['fileId', 'versionId', 'storageKey'],
    namespace,
  });
  const allFiles = await db.findMany<{ fileId: string; policy: string }>({
    model: 'files',
    where: [],
    select: ['fileId', 'policy'],
    namespace,
  });
  const policyByFileId = new Map(allFiles.map((entry) => [entry.fileId, entry.policy]));
  const policyFor = (fileId: string) => policies?.get(policyByFileId.get(fileId) ?? '') ?? {};

  for (const version of allVersions) {
    const ref = storageRef(resolveStorageTarget(policyFor(version.fileId)), version.storageKey);
    if (!isExcluded(version) && candidates.has(ref)) {
      referenced.add(ref);
    }
  }

  const allArtifacts = await db.findMany<{
    fileId: string; versionId: string; kind: string; storageKey: string; metadata?: Record<string, unknown>;
  }>({
    model: 'fileArtifacts',
    where: [],
    select: ['fileId', 'versionId', 'kind', 'storageKey', 'metadata'],
    namespace,
  });
  for (const artifact of allArtifacts) {
    if (referencesNothing(artifact.kind) || isExcluded(artifact)) continue;
    const targets = [resolveArtifactStorageTarget(policyFor(artifact.fileId)), recordedStorageTarget(artifact)];
    for (const target of targets) {
      const ref = target === undefined ? '' : storageRef(target, artifact.storageKey);
      if (candidates.has(ref)) {
        referenced.add(ref);
      }
    }
  }

  return referenced;
}
