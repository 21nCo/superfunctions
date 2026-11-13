import type { Route } from '@superfunctions/http';
import { createAuthFnRouteMeta } from 'authfn/http/router';
import { resolveEndpoints, type OAuthProviderRuntime } from '../runtime.js';

export const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';

/**
 * RFC 8414 authorization server metadata. Served under the AuthFn base path;
 * hosts route `/.well-known/oauth-authorization-server` (with the issuer's
 * path appended, if any) to this route.
 */
export function createMetadataRoute(runtime: OAuthProviderRuntime): Route {
  return {
    method: 'GET',
    path: OAUTH_METADATA_PATH,
    meta: createAuthFnRouteMeta('oauthAuthorizationServerMetadata', 'OAuth 2.1 authorization server metadata', {
      mode: 'none'
    }),
    handler: async (request) => {
      const endpoints = await resolveEndpoints(runtime, request);
      const scopes = [...new Set(runtime.config.resources.flatMap((resource) => resource.scopes))];
      return Response.json({
        issuer: endpoints.issuer,
        authorization_endpoint: endpoints.authorization,
        token_endpoint: endpoints.token,
        revocation_endpoint: endpoints.revocation,
        introspection_endpoint: endpoints.introspection,
        scopes_supported: scopes,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
        revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
        introspection_endpoint_auth_methods_supported: ['bearer'],
        authorization_response_iss_parameter_supported: true
      });
    }
  };
}
