export interface OAuthStateRecord {
  stateId: string;
  tenantId: string;
  userId: string;
  providerId: string;
  redirectUri: string;
  requestedScopes: string[];
  codeVerifier?: string;
  nonce?: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface TokenRecord {
  tokenId: string;
  tenantId: string;
  userId: string;
  providerId: string;
  connectionId: string;
  encryptedPayload: string;
  keyRef: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface OAuthStateStore {
  put(record: OAuthStateRecord): Promise<void>;
  get(stateId: string): Promise<OAuthStateRecord | null>;
  consume(stateId: string, consumedAt: string): Promise<OAuthStateRecord | null>;
  deleteExpired(before: string): Promise<number>;
}

export interface TokenVault {
  put(record: TokenRecord): Promise<void>;
  get(tokenId: string): Promise<TokenRecord | null>;
  getByConnection(connectionId: string): Promise<TokenRecord | null>;
  rotateKey(tokenId: string, newKeyRef: string): Promise<void>;
  deleteByConnection(connectionId: string): Promise<void>;
}

export * from "./state-store.js";
export * from "./token-vault.js";
export * from "./adapters/memory.js";
export * from "./adapters/sql.js";
export * from "./adapters/db.js";
