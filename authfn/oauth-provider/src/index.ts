import type { AuthFnPlugin } from 'authfn';
import { createAuthorizeRoutes } from './authorize/index.js';
import { createIntrospectionRoute } from './introspection/index.js';
import { createMetadataRoute } from './metadata/index.js';
import { createRevocationRoute } from './revocation/index.js';
import {
  createOAuthProviderRuntime,
  OAUTH_PROVIDER_PLUGIN_NAME,
  readOAuthProviderRuntimeConfig
} from './runtime.js';
import { createOAuthProviderSchema } from './store.js';
import { createTokenRoute } from './token/index.js';
import type { OAuthProviderPluginConfig, OAuthProviderPluginRuntimeConfig } from './types.js';

export { OAUTH_AUTHORIZE_PATH } from './authorize/index.js';
export { OAUTH_INTROSPECTION_PATH } from './introspection/index.js';
export { OAUTH_METADATA_PATH } from './metadata/index.js';
export { OAUTH_REVOCATION_PATH } from './revocation/index.js';
export { OAUTH_TOKEN_PATH } from './token/index.js';
export { disconnectOAuthClient, revokeOAuthGrant, verifyOAuthAccessToken, type OAuthStore } from './store.js';
export * from './types.js';

/**
 * OAuth 2.1 authorization server for AuthFn: RFC 8414 metadata, the
 * authorization endpoint (authorization code with PKCE S256 only), the token
 * endpoint (code exchange; refresh with rotation and reuse detection),
 * revocation (RFC 7009) and introspection (RFC 7662). Every token is bound to
 * one resource (RFC 8707) and carries the granted AuthFn scopes.
 */
export function authFnOAuthProviderPlugin(
  config: OAuthProviderPluginConfig = {}
): AuthFnPlugin<typeof OAUTH_PROVIDER_PLUGIN_NAME, OAuthProviderPluginRuntimeConfig, true> {
  return {
    name: OAUTH_PROVIDER_PLUGIN_NAME,
    schema: () => config.schema ?? createOAuthProviderSchema(),
    validateConfig: (runtimeConfig) => {
      readOAuthProviderRuntimeConfig(runtimeConfig);
    },
    routes: (ctx) => {
      const runtime = createOAuthProviderRuntime(ctx);
      return [
        createMetadataRoute(runtime),
        ...createAuthorizeRoutes(runtime),
        createTokenRoute(runtime),
        createRevocationRoute(runtime),
        createIntrospectionRoute(runtime)
      ];
    }
  };
}
