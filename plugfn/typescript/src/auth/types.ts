export interface TokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OAuthState {
  userId: string;
  provider: string;
  redirectUri: string;
  scopes?: string[];
  connectionName?: string;
  timestamp: number;
}

