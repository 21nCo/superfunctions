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

function percentEncode(char: string): string {
  return Array.from(new TextEncoder().encode(char), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

/**
 * Turns one value into a single storage key segment without collisions:
 * `%`, path separators and control characters are percent-encoded, as are the
 * dots of a leading run of two or more dots and a segment that is exactly `.`.
 * Everything else is kept as it is (dots inside a name, underscores, spaces),
 * so safe IDs keep their own segment and distinct IDs never share one (for
 * example `team/east` becomes `team%2Feast`, never `team_east`). An empty
 * value becomes `%20`, which no other value produces.
 */
export function sanitizeStorageKeySegment(value: string): string {
  const encoded = String(value)
    .replace(/[%\\/\u0000-\u001f\u007f-\u009f]/g, percentEncode)
    .replace(/^\.\.+/, (dots) => '%2E'.repeat(dots.length));
  // `%20` is never produced for a nonempty value (a space is kept verbatim and
  // `%` itself is encoded), so it marks an empty value without colliding.
  if (encoded.length === 0) return '%20';
  if (encoded === '.') return '%2E';
  return encoded;
}

/** Longest tenant, principal, file ID or file-name part of a default key, in UTF-8 bytes. */
const MAX_KEY_PART_BYTES = 120;

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A sanitized key part, shortened when it is longer than MAX_KEY_PART_BYTES so
 * each key segment stays within the 255-byte name limit of common
 * filesystems. A shortened part keeps its start, a hash of the whole part and
 * (for file names) its extension. The hash is a marker, not the uniqueness
 * guarantee: default keys stay unique through the version ID.
 */
function boundedKeyPart(value: string, keepExtension: boolean): string {
  const sanitized = sanitizeStorageKeySegment(value);
  const encoder = new TextEncoder();
  if (encoder.encode(sanitized).length <= MAX_KEY_PART_BYTES) return sanitized;
  const extension = keepExtension ? /\.[A-Za-z0-9]{1,10}$/.exec(sanitized)?.[0] ?? '' : '';
  const suffix = `~${fnv1a(sanitized)}${extension}`;
  let head = '';
  for (const char of sanitized) {
    if (encoder.encode(head + char).length + suffix.length > MAX_KEY_PART_BYTES) break;
    head += char;
  }
  // Never end the head inside a percent-escape.
  head = head.replace(/%[0-9A-F]?$/, '');
  return `${head}${suffix}`;
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
  if (ctx.tenantId) parts.push(boundedKeyPart(ctx.tenantId, false));
  if (ctx.principalId) parts.push(boundedKeyPart(ctx.principalId, false));
  parts.push(boundedKeyPart(ctx.fileId, false));
  parts.push(`${sanitizeStorageKeySegment(ctx.versionId)}-${boundedKeyPart(ctx.fileName, true)}`);
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
