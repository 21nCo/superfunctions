export interface PolicyStoragePathContext {
  fileName: string;
  principalId?: string;
  tenantId?: string;
  fileId: string;
  versionId: string;
}

export interface Policy {
  name: string;
  contentTypes?: string[];
  maxSizeBytes?: number;
  visibility?: 'public' | 'private' | 'shared';
  storageTarget?: string;
  artifactStorageTarget?: string;
  lifecycle?: 'durable' | 'temporary';
  renderProfile?: 'default' | 'nucleus';
  storagePath?: (ctx: PolicyStoragePathContext) => string;
}

export interface PolicyRegistry {
  get(name: string): Policy | undefined;
  register(policy: Policy): void;
  list(): Policy[];
}

export type Visibility = 'public' | 'private' | 'shared';
export type RenderProfile = 'default' | 'nucleus';

export const DEFAULT_STORAGE_TARGET = 'durable';
export const NUCLEUS_MAX_SIZE_BYTES = 100 * 1024 * 1024;
export const NUCLEUS_ALLOWED_CONTENT_TYPES = [
  'image/*',
  'audio/*',
  'video/*',
  'application/pdf',
  'text/markdown',
  'text/plain',
] as const;

export interface PolicyRegistryWithDefine extends PolicyRegistry {
  define(name: string, policy: Omit<Policy, 'name'>): void;
}

export function createPolicyRegistry(initialPolicies: Policy[] = []): PolicyRegistryWithDefine {
  const policies = new Map<string, Policy>();

  for (const policy of initialPolicies) {
    policies.set(policy.name, policy);
  }

  return {
    get(name: string): Policy | undefined {
      return policies.get(name);
    },

    register(policy: Policy): void {
      policies.set(policy.name, policy);
    },

    define(name: string, policy: Omit<Policy, 'name'>): void {
      policies.set(name, { name, ...policy });
    },

    list(): Policy[] {
      return Array.from(policies.values());
    },
  };
}

export function validatePolicyConstraints(
  policy: Policy,
  mimeType: string,
  size: number
): { valid: boolean; error?: string } {
  if (policy.contentTypes && policy.contentTypes.length > 0) {
    if (!policy.contentTypes.some((pattern) => matchesContentType(pattern, mimeType))) {
      return { valid: false, error: `Content type '${mimeType}' not allowed by policy '${policy.name}'` };
    }
  }

  if (policy.maxSizeBytes !== undefined && size > policy.maxSizeBytes) {
    return { valid: false, error: `Size ${size} exceeds max ${policy.maxSizeBytes} for policy '${policy.name}'` };
  }

  return { valid: true };
}

// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const STORAGE_KEY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Turns one value into a single storage key segment: path separators become
 * `_`, control characters are dropped, a leading run of two or more dots
 * becomes `_`, and a segment that is empty or `.` becomes `_`. Everything else is kept as it is
 * (repeated underscores, dots inside a name, surrounding spaces), so a safe ID
 * keeps its own segment and a name keeps its extension. Unsafe values can
 * still map onto one segment; default keys stay unique because they end in
 * the version ID.
 */
export function sanitizeStorageKeySegment(value: string): string {
  const sanitized = String(value)
    .replace(STORAGE_KEY_CONTROL_CHARACTERS, '')
    .replace(/[\\/]/g, '_')
    // A segment never starts with `..` (some adapters read that as traversal).
    .replace(/^\.\.+/, '_');
  if (sanitized.length === 0 || /^\.+$/.test(sanitized)) {
    return '_';
  }
  return sanitized;
}

/**
 * Returns why a storage key is unsafe, or null when it is safe. A safe key is
 * relative, uses `/` only, has no empty, `.` or `..` segment and no control
 * characters, so no adapter can resolve it outside its own path.
 */
export function unsafeStorageKeyReason(key: string): string | null {
  if (typeof key !== 'string' || key.length === 0) return 'empty key';
  if (new RegExp(STORAGE_KEY_CONTROL_CHARACTERS.source).test(key)) return 'control character';
  if (key.includes('\\')) return 'backslash';
  if (key.startsWith('/')) return 'absolute key';
  for (const segment of key.split('/')) {
    if (segment === '') return 'empty segment';
    if (segment === '.' || segment === '..') return 'dot segment';
  }
  return null;
}

export function computeStoragePath(
  policy: Policy,
  ctx: PolicyStoragePathContext
): string {
  if (policy.storagePath) {
    return policy.storagePath(ctx);
  }
  const parts: string[] = [];
  if (ctx.tenantId) parts.push(sanitizeStorageKeySegment(ctx.tenantId));
  if (ctx.principalId) parts.push(sanitizeStorageKeySegment(ctx.principalId));
  parts.push(sanitizeStorageKeySegment(ctx.fileId));
  parts.push(`${sanitizeStorageKeySegment(ctx.versionId)}-${sanitizeStorageKeySegment(ctx.fileName)}`);
  return parts.join('/');
}

export function resolveStorageTarget(policy: Pick<Policy, 'storageTarget'>): string {
  return policy.storageTarget || DEFAULT_STORAGE_TARGET;
}

export function resolveArtifactStorageTarget(
  policy: Pick<Policy, 'storageTarget' | 'artifactStorageTarget'>
): string {
  return policy.artifactStorageTarget || resolveStorageTarget(policy);
}

export function matchesContentType(pattern: string, mimeType: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedMimeType = mimeType.toLowerCase();

  if (normalizedPattern === '*/*') {
    return true;
  }

  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, normalizedPattern.length - 1);
    return normalizedMimeType.startsWith(prefix);
  }

  return normalizedPattern === normalizedMimeType;
}

export function createNucleusPolicies(): Policy[] {
  return [
    {
      name: 'nucleus-durable-default',
      contentTypes: [...NUCLEUS_ALLOWED_CONTENT_TYPES],
      maxSizeBytes: NUCLEUS_MAX_SIZE_BYTES,
      visibility: 'private',
      storageTarget: 'durable',
      artifactStorageTarget: 'durable',
      lifecycle: 'durable',
      renderProfile: 'nucleus',
    },
    {
      name: 'nucleus-temporary-default',
      contentTypes: [...NUCLEUS_ALLOWED_CONTENT_TYPES],
      maxSizeBytes: NUCLEUS_MAX_SIZE_BYTES,
      visibility: 'private',
      storageTarget: 'temporary',
      artifactStorageTarget: 'temporary',
      lifecycle: 'temporary',
      renderProfile: 'nucleus',
    },
  ];
}
