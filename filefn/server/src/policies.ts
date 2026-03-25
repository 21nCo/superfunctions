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

export function computeStoragePath(
  policy: Policy,
  ctx: PolicyStoragePathContext
): string {
  if (policy.storagePath) {
    return policy.storagePath(ctx);
  }
  const parts: string[] = [];
  if (ctx.tenantId) parts.push(ctx.tenantId);
  if (ctx.principalId) parts.push(ctx.principalId);
  parts.push(ctx.fileId);
  parts.push(`${ctx.versionId}-${ctx.fileName}`);
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
  if (pattern === '*/*') {
    return true;
  }

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, pattern.length - 1);
    return mimeType.startsWith(prefix);
  }

  return pattern === mimeType;
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
