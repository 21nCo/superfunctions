import type { Adapter } from '@superfunctions/db';
import { createKeyedSerializer } from '../upload-sessions/file-id.js';

/**
 * The one serializer, across every FileFn instance in this process, for the
 * database steps that create files: upload completion's session and fileId keys
 * and import's object and fileId keys. Calls that claim one file ID wait for
 * each other through the same key, whichever path they come from.
 */
export const runFileFnSerialized = createKeyedSerializer();

// One token per database adapter object the host passed. Used on adapters with
// unique constraints, where calls against different databases then never wait
// on each other, and adapter objects that share one store but get different
// tokens are arbitrated by the unique `files.fileId` constraint, as across
// processes.
const databaseTokens = new WeakMap<object, string>();
let nextDatabaseToken = 0;
function databaseToken(database: object): string {
  let token = databaseTokens.get(database);
  if (token === undefined) {
    token = String(nextDatabaseToken++);
    databaseTokens.set(database, token);
  }
  return token;
}

const IMPORT_MEMBER_PREFIX = 'import\u0000';

export interface FileCommitLockConfig {
  db: Adapter;
  namespace: string;
  /** The database the host passed, before FileFn's wrappers (default `db`). */
  databaseIdentity?: object;
}

/**
 * The per-fileId commit key of one FileFn store, shared by upload completion
 * and import. With unique constraints the key is scoped to the adapter object;
 * without them (single-process adapters) it is scoped to the namespace, and
 * calls of one key form one group per store (`sharesKeyWith`): a busy key's
 * group is this store's when one of its upload sessions is visible here, or
 * when it holds an import. No adapter property reliably tells whether two
 * adapter objects (for example two wrappers) share one store, and an import
 * leaves no session row to find, so every import's turn counts as this
 * store's: calls through any adapter object of the namespace wait for it.
 * Calls of separate stores that share a namespace may then wait for each
 * other's imports, which only orders them.
 */
export function createFileCommitLock(config: FileCommitLockConfig) {
  const { db, namespace, databaseIdentity = db } = config;
  const uniqueConstraints = db.capabilities?.schema?.constraints === true;
  const scope = uniqueConstraints ? `${databaseToken(databaseIdentity)}\u0000${namespace}` : namespace;
  const importMember = `${IMPORT_MEMBER_PREFIX}${namespace}`;

  async function inThisStore(members: readonly string[]): Promise<boolean> {
    // The key is this namespace's, so any import holding or awaiting it is.
    if (members.some((member) => member.startsWith(IMPORT_MEMBER_PREFIX))) return true;
    const uploadSessionIds = members.filter((member) => !member.startsWith(IMPORT_MEMBER_PREFIX));
    const found = await Promise.all(uploadSessionIds.map((uploadSessionId) => db.findOne({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      namespace,
    })));
    return found.some(Boolean);
  }

  return {
    uniqueConstraints,
    /** Scope of this store's keys (namespace, plus the adapter with unique constraints). */
    scope,
    /** Key of the commit decisions for one file ID. */
    fileKey: (fileId: string) => `file\u0000${scope}\u0000${fileId}`,
    /** `member` of an import's turn on a file key. */
    importMember,
    /** `sharesKeyWith` for file keys: only without unique constraints. */
    sharesKeyWith: uniqueConstraints ? undefined : inThisStore,
  };
}
