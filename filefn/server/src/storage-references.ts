import type { Adapter } from '@superfunctions/db';
import { resolveArtifactStorageTarget, resolveStorageTarget, type PolicyRegistry } from './policies.js';
import { PROCESSING_RUN_KIND } from './processing/service.js';

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
 * row still references; a processing run row stores no object and references
 * nothing. Each row's target comes from its file's policy: the storage target
 * for a version, the artifact storage target for an artifact.
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

  const allArtifacts = await db.findMany<{ fileId: string; versionId: string; kind: string; storageKey: string }>({
    model: 'fileArtifacts',
    where: [],
    select: ['fileId', 'versionId', 'kind', 'storageKey'],
    namespace,
  });
  for (const artifact of allArtifacts) {
    // A processing run row stores no object; its key is a placeholder.
    if (artifact.kind === PROCESSING_RUN_KIND) continue;
    const ref = storageRef(resolveArtifactStorageTarget(policyFor(artifact.fileId)), artifact.storageKey);
    if (!isExcluded(artifact) && candidates.has(ref)) {
      referenced.add(ref);
    }
  }

  return referenced;
}
