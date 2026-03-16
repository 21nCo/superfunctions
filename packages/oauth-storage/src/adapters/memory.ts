import type { OAuthStateRecord, OAuthStateStore, TokenRecord, TokenVault } from "../index.js";

export class MemoryOAuthStateStore implements OAuthStateStore {
  private readonly records = new Map<string, OAuthStateRecord>();

  async put(record: OAuthStateRecord): Promise<void> {
    this.records.set(record.stateId, cloneStateRecord(record));
  }

  async get(stateId: string): Promise<OAuthStateRecord | null> {
    const record = this.records.get(stateId);
    return record ? cloneStateRecord(record) : null;
  }

  async consume(stateId: string, consumedAt: string): Promise<OAuthStateRecord | null> {
    const record = this.records.get(stateId);
    if (!record) {
      return null;
    }

    if (record.consumedAt) {
      return null;
    }

    if (Date.parse(record.expiresAt) <= Date.parse(consumedAt)) {
      return null;
    }

    const consumed: OAuthStateRecord = { ...record, consumedAt };
    this.records.set(stateId, consumed);
    return cloneStateRecord(consumed);
  }

  async deleteExpired(before: string): Promise<number> {
    const checkpoint = Date.parse(before);
    let deleted = 0;

    for (const [stateId, record] of this.records.entries()) {
      if (Date.parse(record.expiresAt) < checkpoint) {
        this.records.delete(stateId);
        deleted += 1;
      }
    }

    return deleted;
  }
}

export class MemoryTokenVault implements TokenVault {
  private readonly tokensById = new Map<string, TokenRecord>();
  private readonly tokenByConnection = new Map<string, string>();

  async put(record: TokenRecord): Promise<void> {
    const existingTokenId = this.tokenByConnection.get(record.connectionId);
    if (existingTokenId && existingTokenId !== record.tokenId) {
      this.tokensById.delete(existingTokenId);
    }

    this.tokensById.set(record.tokenId, cloneTokenRecord(record));
    this.tokenByConnection.set(record.connectionId, record.tokenId);
  }

  async get(tokenId: string): Promise<TokenRecord | null> {
    const record = this.tokensById.get(tokenId);
    return record ? cloneTokenRecord(record) : null;
  }

  async getByConnection(connectionId: string): Promise<TokenRecord | null> {
    const tokenId = this.tokenByConnection.get(connectionId);
    if (!tokenId) {
      return null;
    }

    const record = this.tokensById.get(tokenId);
    return record ? cloneTokenRecord(record) : null;
  }

  async rotateKey(tokenId: string, newKeyRef: string): Promise<void> {
    const existing = this.tokensById.get(tokenId);
    if (!existing) {
      return;
    }

    this.tokensById.set(tokenId, {
      ...existing,
      keyRef: newKeyRef,
      updatedAt: new Date().toISOString()
    });
  }

  async deleteByConnection(connectionId: string): Promise<void> {
    const tokenId = this.tokenByConnection.get(connectionId);
    if (!tokenId) {
      return;
    }

    this.tokenByConnection.delete(connectionId);
    this.tokensById.delete(tokenId);
  }
}

function cloneStateRecord(record: OAuthStateRecord): OAuthStateRecord {
  return { ...record, requestedScopes: [...record.requestedScopes] };
}

function cloneTokenRecord(record: TokenRecord): TokenRecord {
  return { ...record };
}
