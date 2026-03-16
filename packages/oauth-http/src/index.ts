import type { OAuthProviderDescriptor } from "@superfunctions/oauth-core";

export type OAuthTokenGrantType =
  | "authorization_code"
  | "refresh_token"
  | "client_credentials";

export interface OAuthTokenEndpointRequest {
  provider: OAuthProviderDescriptor;
  grantType: OAuthTokenGrantType;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  code?: string;
  codeVerifier?: string;
  refreshToken?: string;
  scopes?: string[];
}

export interface OAuthTokenEndpointResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
  idToken?: string;
  raw?: unknown;
}

export interface OAuthRevocationRequest {
  provider: OAuthProviderDescriptor;
  clientId: string;
  clientSecret: string;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
}

export interface OAuthTokenHttpClient {
  exchangeToken(input: OAuthTokenEndpointRequest): Promise<OAuthTokenEndpointResponse>;
  revokeToken(input: OAuthRevocationRequest): Promise<void>;
}

export * from "./errors.js";
export * from "./retry-policy.js";
export * from "./token-client.js";
