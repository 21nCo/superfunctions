import type { OAuth2Config, OAuth2RuntimeConfig, TokenResponse } from '../types/provider.js';
import type { TokenStore, OAuthState } from './types.js';
import { generateState } from '../utils/crypto.js';
import { addQueryParams } from '../utils/url-builder.js';

/**
 * OAuth 2.0 flow handler
 */
export class OAuthFlowHandler {
  constructor(
    private tokenStore: TokenStore,
    private stateTimeout = 600000 // 10 minutes
  ) {}

  /**
   * Generate authorization URL for OAuth flow
   */
  async getAuthorizationUrl(
    config: OAuth2Config,
    runtimeConfig: OAuth2RuntimeConfig
  ): Promise<{ url: string; state: string }> {
    const state = runtimeConfig.state || generateState();
    
    // Store state with metadata
    const stateData: OAuthState = {
      userId: '', // Will be set by caller
      provider: '',
      redirectUri: runtimeConfig.redirectUri,
      scopes: runtimeConfig.scopes,
      timestamp: Date.now(),
    };
    
    await this.tokenStore.set(`oauth:state:${state}`, JSON.stringify(stateData), this.stateTimeout);
    
    const params = config.getAuthParams
      ? config.getAuthParams(runtimeConfig)
      : this.getDefaultAuthParams(config, runtimeConfig, state);
    
    const url = addQueryParams(config.authorizationUrl, params);
    
    return { url, state };
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    config: OAuth2Config,
    runtimeConfig: OAuth2RuntimeConfig,
    code: string
  ): Promise<TokenResponse> {
    const params = config.getTokenParams
      ? config.getTokenParams(runtimeConfig, code)
      : this.getDefaultTokenParams(runtimeConfig, code);
    
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OAuth token exchange failed: ${error}`);
    }
    
    return response.json() as Promise<TokenResponse>;
  }

  /**
   * Refresh an access token
   */
  async refreshAccessToken(
    config: OAuth2Config,
    runtimeConfig: OAuth2RuntimeConfig,
    refreshToken: string
  ): Promise<TokenResponse> {
    if (!config.refreshToken) {
      throw new Error('Token refresh not supported by this provider');
    }
    
    return config.refreshToken(runtimeConfig, refreshToken);
  }

  /**
   * Verify and retrieve OAuth state
   */
  async verifyState(state: string): Promise<OAuthState | null> {
    const stateData = await this.tokenStore.get(`oauth:state:${state}`);
    
    if (!stateData) {
      return null;
    }
    
    // Delete state after verification (one-time use)
    await this.tokenStore.delete(`oauth:state:${state}`);
    
    const parsed: OAuthState = JSON.parse(stateData);
    
    // Check if state has expired
    if (Date.now() - parsed.timestamp > this.stateTimeout) {
      return null;
    }
    
    return parsed;
  }

  /**
   * Default authorization parameters
   */
  private getDefaultAuthParams(
    config: OAuth2Config,
    runtimeConfig: OAuth2RuntimeConfig,
    state: string
  ): Record<string, string> {
    return {
      response_type: 'code',
      client_id: runtimeConfig.clientId,
      redirect_uri: runtimeConfig.redirectUri,
      scope: runtimeConfig.scopes.join(config.scopeSeparator || ' '),
      state,
    };
  }

  /**
   * Default token exchange parameters
   */
  private getDefaultTokenParams(
    runtimeConfig: OAuth2RuntimeConfig,
    code: string
  ): Record<string, string> {
    return {
      grant_type: 'authorization_code',
      code,
      client_id: runtimeConfig.clientId,
      client_secret: runtimeConfig.clientSecret,
      redirect_uri: runtimeConfig.redirectUri,
    };
  }
}

