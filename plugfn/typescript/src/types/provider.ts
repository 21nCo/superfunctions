import type { Action } from './action.js';
import type { Trigger } from './trigger.js';

/**
 * Authentication types supported by providers
 */
export enum AuthType {
  OAuth2 = 'oauth2',
  ApiKey = 'api-key',
  JWT = 'jwt',
  Basic = 'basic',
  None = 'none',
}

/**
 * OAuth 2.0 configuration
 */
export interface OAuth2Config {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  scopeSeparator?: string;
  getAuthParams?: (config: OAuth2RuntimeConfig) => Record<string, string>;
  getTokenParams?: (config: OAuth2RuntimeConfig, code: string) => Record<string, any>;
  refreshToken?: (config: OAuth2RuntimeConfig, refreshToken: string) => Promise<TokenResponse>;
}

export interface OAuth2RuntimeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/**
 * API Key configuration
 */
export interface ApiKeyConfig {
  headerName?: string;
  paramName?: string;
  prefix?: string;
}

/**
 * JWT configuration
 */
export interface JWTConfig {
  algorithm: string;
  publicKey?: string;
  privateKey?: string;
  issuer?: string;
  audience?: string;
}

/**
 * Basic Auth configuration
 */
export interface BasicAuthConfig {
  usernameField?: string;
  passwordField?: string;
}

/**
 * Authentication configuration union
 */
export type AuthConfig =
  | { type: AuthType.OAuth2; config: OAuth2Config }
  | { type: AuthType.ApiKey; config: ApiKeyConfig }
  | { type: AuthType.JWT; config: JWTConfig }
  | { type: AuthType.Basic; config: BasicAuthConfig }
  | { type: AuthType.None; config?: never };

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  requests: number;
  window: number; // milliseconds
  strategy?: 'sliding' | 'fixed';
}

/**
 * Provider metadata and configuration
 */
export interface Provider<TActions extends Record<string, Action<any, any>> = any> {
  name: string;
  displayName: string;
  version: string;
  description: string;
  iconUrl?: string;
  auth: AuthConfig;
  baseUrl: string;
  actions: TActions;
  triggers?: Record<string, Trigger<any>>;
  rateLimit?: RateLimitConfig;
  headers?: Record<string, string>;
  transformRequest?: (request: any) => any;
  transformResponse?: (response: any) => any;
}

/**
 * Provider status
 */
export enum ProviderStatus {
  Available = 'available',
  Configured = 'configured',
  Unavailable = 'unavailable',
}

/**
 * Provider info returned to users
 */
export interface ProviderInfo {
  name: string;
  displayName: string;
  description: string;
  iconUrl?: string;
  authType: AuthType;
  status: ProviderStatus;
  version: string;
  actionsCount: number;
  triggersCount: number;
}

