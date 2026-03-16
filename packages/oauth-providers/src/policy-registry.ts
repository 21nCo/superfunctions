import type { OAuthProviderDescriptor } from "@superfunctions/oauth-core";

export type OAuthProviderId = "google" | "microsoft" | "yahoo" | "apple" | "github";
export type ProviderFeatureMode = "metadata-only" | "snippet" | "full-body";

export interface ProviderCapabilityPolicy {
  supportsMailRead: boolean;
  supportsMailSend: boolean;
  supportsWatch: boolean;
  supportsRevoke: boolean;
  supportsManagedMailbox: boolean;
  allowedFeatureModes: ProviderFeatureMode[];
}

export interface ProviderFeatureScopePolicy {
  allowedScopes: string[];
  restrictedScopes?: string[];
}

export interface ProviderOperationPolicy {
  allowed: boolean;
  reason?: string;
  requiredFeatureMode?: ProviderFeatureMode;
}

export interface ProviderPolicyDefinition {
  providerId: OAuthProviderId;
  policyVersion: string;
  descriptor: OAuthProviderDescriptor;
  capabilities: ProviderCapabilityPolicy;
  featureScopes: Record<string, ProviderFeatureScopePolicy>;
  operationPolicies: Record<string, ProviderOperationPolicy>;
}

export interface ScopeValidationInput {
  providerId: OAuthProviderId;
  feature: string;
  requestedScopes: string[];
  tenantId: string;
  userId: string;
  purpose: string;
}

export interface ScopeValidationResult {
  authorized: true;
  consentRecord: ConsentRecord;
}

export interface ConsentRecord {
  consentId: string;
  tenantId: string;
  userId: string;
  providerId: OAuthProviderId;
  feature: string;
  scopes: string[];
  purpose: string;
  grantedAt: string;
  policyVersion: string;
}

export interface OperationCheckInput {
  providerId: OAuthProviderId;
  operation: string;
  featureMode?: ProviderFeatureMode;
}

export interface OperationCheckResult {
  allowed: true;
  policyVersion: string;
}

export interface PolicyVersionUpdateInput {
  providerId: OAuthProviderId;
  newVersion: string;
  actor: string;
  reason: string;
  changedAt?: string;
}

export interface PolicyAuditEvent {
  providerId: OAuthProviderId;
  fromVersion: string;
  toVersion: string;
  actor: string;
  reason: string;
  changedAt: string;
}

export class ProviderPolicyError extends Error {
  readonly code: "OAUTH_SCOPE_DISALLOWED" | "PROVIDER_POLICY_BLOCKED" | "VALIDATION_ERROR";
  readonly details?: Record<string, unknown>;

  constructor(
    code: "OAUTH_SCOPE_DISALLOWED" | "PROVIDER_POLICY_BLOCKED" | "VALIDATION_ERROR",
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ProviderPolicyError";
    this.code = code;
    this.details = details;
  }
}

export class ProviderPolicyRegistry {
  private readonly policies = new Map<OAuthProviderId, ProviderPolicyDefinition>();
  private readonly consentRecords: ConsentRecord[] = [];
  private readonly auditEvents: PolicyAuditEvent[] = [];
  private readonly now: () => string;

  constructor(policies: ReadonlyArray<ProviderPolicyDefinition>, now: () => string = () => new Date().toISOString()) {
    for (const policy of policies) {
      this.policies.set(policy.providerId, clonePolicy(policy));
    }

    this.now = now;
  }

  getPolicy(providerId: OAuthProviderId): ProviderPolicyDefinition {
    const policy = this.policies.get(providerId);
    if (!policy) {
      throw new ProviderPolicyError("VALIDATION_ERROR", `provider policy not found: ${providerId}`);
    }

    return clonePolicy(policy);
  }

  listPolicies(): ProviderPolicyDefinition[] {
    return [...this.policies.values()].map((policy) => clonePolicy(policy));
  }

  validateScopes(input: ScopeValidationInput): ScopeValidationResult {
    const policy = this.getPolicy(input.providerId);
    const featurePolicy = policy.featureScopes[input.feature];
    if (!featurePolicy) {
      throw new ProviderPolicyError("VALIDATION_ERROR", "feature scope policy not found", {
        providerId: input.providerId,
        feature: input.feature
      });
    }

    const disallowedScope = input.requestedScopes.find((scope) => !featurePolicy.allowedScopes.includes(scope));
    if (disallowedScope) {
      throw new ProviderPolicyError("OAUTH_SCOPE_DISALLOWED", "requested scope not allowed for feature", {
        providerId: input.providerId,
        feature: input.feature,
        scope: disallowedScope
      });
    }

    const consentRecord: ConsentRecord = {
      consentId: createConsentId(),
      tenantId: input.tenantId,
      userId: input.userId,
      providerId: input.providerId,
      feature: input.feature,
      scopes: [...input.requestedScopes],
      purpose: input.purpose,
      grantedAt: this.now(),
      policyVersion: policy.policyVersion
    };

    this.consentRecords.push(consentRecord);
    return {
      authorized: true,
      consentRecord: cloneConsent(consentRecord)
    };
  }

  assertOperationAllowed(input: OperationCheckInput): OperationCheckResult {
    const policy = this.getPolicy(input.providerId);
    const operationPolicy = policy.operationPolicies[input.operation];
    if (!operationPolicy || !operationPolicy.allowed) {
      throw new ProviderPolicyError("PROVIDER_POLICY_BLOCKED", "operation not allowed by policy", {
        providerId: input.providerId,
        operation: input.operation,
        policyVersion: policy.policyVersion
      });
    }

    if (operationPolicy.requiredFeatureMode && input.featureMode !== operationPolicy.requiredFeatureMode) {
      throw new ProviderPolicyError("PROVIDER_POLICY_BLOCKED", "operation not allowed by policy", {
        providerId: input.providerId,
        operation: input.operation,
        policyVersion: policy.policyVersion,
        requiredFeatureMode: operationPolicy.requiredFeatureMode,
        featureMode: input.featureMode
      });
    }

    return {
      allowed: true,
      policyVersion: policy.policyVersion
    };
  }

  recordPolicyVersionUpdate(input: PolicyVersionUpdateInput): PolicyAuditEvent {
    const currentPolicy = this.policies.get(input.providerId);
    if (!currentPolicy) {
      throw new ProviderPolicyError("VALIDATION_ERROR", `provider policy not found: ${input.providerId}`);
    }

    const updated: ProviderPolicyDefinition = {
      ...currentPolicy,
      policyVersion: input.newVersion
    };
    this.policies.set(input.providerId, updated);

    const auditEvent: PolicyAuditEvent = {
      providerId: input.providerId,
      fromVersion: currentPolicy.policyVersion,
      toVersion: input.newVersion,
      actor: input.actor,
      reason: input.reason,
      changedAt: input.changedAt ?? this.now()
    };
    this.auditEvents.push(auditEvent);
    return { ...auditEvent };
  }

  getConsentRecords(): ConsentRecord[] {
    return this.consentRecords.map((record) => cloneConsent(record));
  }

  getPolicyAuditEvents(): PolicyAuditEvent[] {
    return this.auditEvents.map((event) => ({ ...event }));
  }
}

function createConsentId(): string {
  const entropy = Math.random().toString(36).slice(2, 10);
  return `consent_${entropy}`;
}

function clonePolicy(policy: ProviderPolicyDefinition): ProviderPolicyDefinition {
  return {
    providerId: policy.providerId,
    policyVersion: policy.policyVersion,
    descriptor: {
      ...policy.descriptor,
      defaultScopes: [...policy.descriptor.defaultScopes],
      extraAuthParams: policy.descriptor.extraAuthParams ? { ...policy.descriptor.extraAuthParams } : undefined
    },
    capabilities: {
      ...policy.capabilities,
      allowedFeatureModes: [...policy.capabilities.allowedFeatureModes]
    },
    featureScopes: Object.fromEntries(
      Object.entries(policy.featureScopes).map(([feature, value]) => [
        feature,
        {
          allowedScopes: [...value.allowedScopes],
          restrictedScopes: value.restrictedScopes ? [...value.restrictedScopes] : undefined
        }
      ])
    ),
    operationPolicies: Object.fromEntries(
      Object.entries(policy.operationPolicies).map(([operation, value]) => [operation, { ...value }])
    )
  };
}

function cloneConsent(record: ConsentRecord): ConsentRecord {
  return {
    ...record,
    scopes: [...record.scopes]
  };
}
