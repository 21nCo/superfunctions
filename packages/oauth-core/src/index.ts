export interface OAuthProviderDescriptor {
  id: string;
  authorizationUrl: string;
  tokenUrl: string;
  revocationUrl?: string;
  defaultScopes: string[];
  supportsPkce: boolean;
  supportsRefreshToken: boolean;
  scopeSeparator?: " " | ",";
  extraAuthParams?: Record<string, string>;
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic";
}

export interface AuthorizationRequest {
  providerId: string;
  tenantId: string;
  userId: string;
  redirectUri: string;
  scopes?: string[];
  connectionName?: string;
  prompt?: string;
  loginHint?: string;
}

export interface AuthorizationResult {
  authorizationUrl: string;
  stateId: string;
  expiresAt: string;
}

export interface OAuthCallbackInput {
  providerId: string;
  code: string;
  state: string;
  redirectUri: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
  idToken?: string;
}

export interface OAuthService {
  createAuthorizationRequest(input: AuthorizationRequest): Promise<AuthorizationResult>;
  handleCallback(input: OAuthCallbackInput): Promise<OAuthTokenSet>;
  refresh(input: {
    providerId: string;
    refreshToken: string;
    redirectUri: string;
    scopes?: string[];
  }): Promise<OAuthTokenSet>;
  revoke(input: {
    providerId: string;
    token: string;
    tokenTypeHint?: "access_token" | "refresh_token";
  }): Promise<void>;
}

export * from "./pkce.js";
export * from "./state.js";
export * from "./service.js";
