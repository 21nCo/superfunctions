/** Host approval means trusting the exact fork code with the named secrets; it is not a sandbox. */
export interface ForkApproval {
  id: string;
  baseRepositoryId: number;
  baseRepository: string;
  baseRepositoryUrl: string;
  baseSha: string;
  headRepositoryId: number;
  headRepository: string;
  headRepositoryUrl: string;
  headSha: string;
  allowedSecrets?: readonly string[];
}
export function safeRepositoryUrl(value: string): boolean {
  if (!value || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return false;
  if (value.startsWith('/')) return true; // Actual checkout still requires explicit local-host policy.
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}
/** Validate and detach from caller-owned arrays before any asynchronous request work. */
export function snapshotForkApprovals(value: readonly ForkApproval[] | undefined): readonly ForkApproval[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid fork approval configuration');
  const ids = new Set<string>();
  return Object.freeze(value.map((entry: ForkApproval) => {
    const keys = ['id','baseRepositoryId','baseRepository','baseRepositoryUrl','baseSha','headRepositoryId','headRepository','headRepositoryUrl','headSha','allowedSecrets'];
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !keys.includes(key)) || typeof entry.id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Invalid fork approval configuration');
    for (const prefix of ['base', 'head'] as const) {
      if (!Number.isSafeInteger(entry[`${prefix}RepositoryId`]) || entry[`${prefix}RepositoryId`] <= 0 || typeof entry[`${prefix}Repository`] !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry[`${prefix}Repository`]) || typeof entry[`${prefix}RepositoryUrl`] !== 'string' || !safeRepositoryUrl(entry[`${prefix}RepositoryUrl`]) || typeof entry[`${prefix}Sha`] !== 'string' || !/^[a-f0-9]{40}$/.test(entry[`${prefix}Sha`]) || /^0+$/.test(entry[`${prefix}Sha`])) throw new Error('Invalid fork approval configuration');
    }
    if (entry.baseRepositoryId === entry.headRepositoryId || (entry.allowedSecrets !== undefined && (!Array.isArray(entry.allowedSecrets) || entry.allowedSecrets.length > 100 || entry.allowedSecrets.some(name => typeof name !== 'string' || !name || name.length > 256 || /[\x00-\x1f\x7f]/.test(name))))) throw new Error('Invalid fork approval configuration');
    ids.add(entry.id);
    return Object.freeze({ ...entry, allowedSecrets: Object.freeze([...new Set(entry.allowedSecrets ?? [])]) });
  }));
}
