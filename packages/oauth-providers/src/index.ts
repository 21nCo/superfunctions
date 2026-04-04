import type { OAuthProviderDescriptor } from "@superfunctions/oauth-core";
import { appleOAuthProviderDescriptor, appleProviderPolicy } from "./providers/apple.js";
import { githubOAuthProviderDescriptor, githubProviderPolicy } from "./providers/github.js";
import { googleOAuthProviderDescriptor, googleProviderPolicy } from "./providers/google.js";
import { microsoftOAuthProviderDescriptor, microsoftProviderPolicy } from "./providers/microsoft.js";
import { yahooOAuthProviderDescriptor, yahooProviderPolicy } from "./providers/yahoo.js";
import {
  ProviderPolicyRegistry,
  type OAuthProviderId,
  type ProviderPolicyDefinition,
  type ProviderPolicyRegistryOptions
} from "./policy-registry.js";
import { MemoryProviderPolicyAuditStore, MemoryProviderPolicyConsentStore } from "./stores.js";

export const authOAuthProviderIds = ["google", "apple", "github"] as const;
export type AuthOAuthProviderId = (typeof authOAuthProviderIds)[number];

export const oauthProviderDescriptors: Record<OAuthProviderId, OAuthProviderDescriptor> = {
  google: googleOAuthProviderDescriptor,
  microsoft: microsoftOAuthProviderDescriptor,
  yahoo: yahooOAuthProviderDescriptor,
  apple: appleOAuthProviderDescriptor,
  github: githubOAuthProviderDescriptor
};

export const oauthProviderPolicies: Record<OAuthProviderId, ProviderPolicyDefinition> = {
  google: googleProviderPolicy,
  microsoft: microsoftProviderPolicy,
  yahoo: yahooProviderPolicy,
  apple: appleProviderPolicy,
  github: githubProviderPolicy
};

export function getOAuthProviderDescriptor(providerId: OAuthProviderId): OAuthProviderDescriptor {
  return oauthProviderDescriptors[providerId];
}

export function listOAuthProviderDescriptors(): OAuthProviderDescriptor[] {
  return Object.values(oauthProviderDescriptors);
}

export function listAuthOAuthProviderDescriptors(): OAuthProviderDescriptor[] {
  return authOAuthProviderIds.map((providerId) => oauthProviderDescriptors[providerId]);
}

export function getProviderPolicy(providerId: OAuthProviderId): ProviderPolicyDefinition {
  return oauthProviderPolicies[providerId];
}

export function listProviderPolicies(): ProviderPolicyDefinition[] {
  return Object.values(oauthProviderPolicies);
}

export function listAuthProviderPolicies(): ProviderPolicyDefinition[] {
  return authOAuthProviderIds.map((providerId) => oauthProviderPolicies[providerId]);
}

export function createDefaultProviderPolicyRegistry(
  options?: ProviderPolicyRegistryOptions | (() => string)
): ProviderPolicyRegistry {
  const resolvedOptions = typeof options === "function" ? { now: options } : options;
  return new ProviderPolicyRegistry(listProviderPolicies(), {
    ...resolvedOptions,
    consentStore: resolvedOptions?.consentStore ?? new MemoryProviderPolicyConsentStore(),
    auditStore: resolvedOptions?.auditStore ?? new MemoryProviderPolicyAuditStore()
  });
}

export * from "./policy-registry.js";
export * from "./stores.js";
export * from "./providers/google.js";
export * from "./providers/microsoft.js";
export * from "./providers/yahoo.js";
export * from "./providers/apple.js";
export * from "./providers/github.js";
