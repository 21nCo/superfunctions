import type { OAuthProviderDescriptor } from "@superfunctions/oauth-core";
import type { ProviderPolicyDefinition } from "../policy-registry.js";

export const githubOAuthProviderDescriptor: OAuthProviderDescriptor = {
  id: "github",
  authorizationUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  revocationUrl: "https://api.github.com/applications/{client_id}/token",
  defaultScopes: ["read:user", "user:email"],
  supportsPkce: true,
  supportsRefreshToken: false,
  scopeSeparator: " ",
  tokenAuthMethod: "client_secret_post"
};

export const githubProviderPolicy: ProviderPolicyDefinition = {
  providerId: "github",
  policyVersion: "2026-03-11",
  descriptor: githubOAuthProviderDescriptor,
  capabilities: {
    supportsMailRead: false,
    supportsMailSend: false,
    supportsWatch: false,
    supportsRevoke: true,
    supportsManagedMailbox: false,
    allowedFeatureModes: ["metadata-only"]
  },
  featureScopes: {
    "profile.basic": {
      allowedScopes: ["read:user", "user:email"]
    }
  },
  operationPolicies: {
    "mail.watch.create": {
      allowed: false,
      reason: "GitHub OAuth descriptor is social-only in shared registry"
    },
    "mail.read.metadata": {
      allowed: false,
      reason: "GitHub OAuth descriptor is social-only in shared registry"
    },
    "mail.read.fullbody": {
      allowed: false,
      reason: "GitHub OAuth descriptor is social-only in shared registry"
    },
    "mail.send": {
      allowed: false,
      reason: "GitHub OAuth descriptor is social-only in shared registry"
    },
    "oauth.revoke": {
      allowed: true
    }
  }
};
