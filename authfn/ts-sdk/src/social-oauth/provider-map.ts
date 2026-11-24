import type { OAuthProviderDescriptor } from '@superfunctions/oauth-core';
import {
  getOAuthProviderDescriptor,
  type OAuthProviderId,
} from '@superfunctions/oauth-providers';
import type { SocialProviderId } from './types.js';

export interface SocialProviderMap {
  providers: Record<SocialProviderId, OAuthProviderDescriptor>;
}

export function createSocialProviderMap(
  providerIds: SocialProviderId[] = ['google', 'microsoft', 'github', 'apple', 'yahoo']
): SocialProviderMap {
  const providers: Partial<Record<SocialProviderId, OAuthProviderDescriptor>> = {};
  for (const providerId of providerIds) {
    providers[providerId] = getOAuthProviderDescriptor(providerId as OAuthProviderId);
  }
  return {
    providers: providers as Record<SocialProviderId, OAuthProviderDescriptor>,
  };
}

export function resolveSocialProviderId(value: string): SocialProviderId {
  const normalized = value.trim().toLowerCase();
  if (
    normalized !== 'google' &&
    normalized !== 'microsoft' &&
    normalized !== 'github' &&
    normalized !== 'apple' &&
    normalized !== 'yahoo'
  ) {
    throw new Error(`unsupported social provider: ${value}`);
  }
  return normalized;
}
