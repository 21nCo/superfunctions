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
  storagePath?: (ctx: PolicyStoragePathContext) => string;
}

export interface PolicyRegistry {
  get(name: string): Policy | undefined;
  register(policy: Policy): void;
  list(): Policy[];
}

export type Visibility = 'public' | 'private' | 'shared';

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
    if (!policy.contentTypes.includes(mimeType)) {
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
