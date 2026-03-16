import type { Adapter, WhereClause } from "@superfunctions/db";
import type { OAuthStateRecord, OAuthStateStore, TokenRecord, TokenVault } from "../index.js";

export interface OAuthDbModelMapping {
  oauthStates: string;
  oauthTokenVault: string;
}

export interface OAuthDbAdapterOptions {
  adapter: Adapter;
  models?: Partial<OAuthDbModelMapping>;
}

export type OAuthDbAdapterErrorCode = "SCHEMA_MISSING" | "INTERNAL_ERROR";

export class OAuthDbAdapterError extends Error {
  readonly code: OAuthDbAdapterErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: OAuthDbAdapterErrorCode, message: string) {
    super(message);
    this.name = "OAuthDbAdapterError";
    this.code = code;
    this.status = 500;
    this.retryable = false;
  }
}

const DEFAULT_MODELS: OAuthDbModelMapping = {
  oauthStates: "oauth_states",
  oauthTokenVault: "oauth_token_vault"
};

type StateRow = {
  state_id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  redirect_uri: string;
  requested_scopes: string;
  code_verifier?: string | null;
  nonce?: string | null;
  created_at: string;
  expires_at: string;
  consumed_at?: string | null;
};

type TokenRow = {
  token_id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  connection_id: string;
  encrypted_payload: string;
  key_ref: string;
  created_at: string;
  updated_at: string;
  expires_at?: string | null;
};

export class DbAdapterOAuthStateStore implements OAuthStateStore {
  private readonly adapter: Adapter;
  private readonly model: string;

  constructor(adapter: Adapter, model = DEFAULT_MODELS.oauthStates) {
    this.adapter = adapter;
    this.model = model;
  }

  async put(record: OAuthStateRecord): Promise<void> {
    await this.adapter.upsert({
      model: this.model,
      where: [{ field: "state_id", operator: "eq", value: record.stateId }],
      create: mapStateRecordToRow(record),
      update: mapStateRecordToRow(record),
      conflictTarget: "state_id"
    });
  }

  async get(stateId: string): Promise<OAuthStateRecord | null> {
    const row = await this.adapter.findOne<StateRow>({
      model: this.model,
      where: [{ field: "state_id", operator: "eq", value: stateId }]
    });

    return row ? mapStateRowToRecord(row) : null;
  }

  async consume(stateId: string, consumedAt: string): Promise<OAuthStateRecord | null> {
    const where: WhereClause[] = [
      { field: "state_id", operator: "eq", value: stateId },
      { field: "consumed_at", operator: "eq", value: null },
      { field: "expires_at", operator: "gt", value: consumedAt }
    ];

    try {
      const updated = await this.adapter.update<StateRow>({
        model: this.model,
        where,
        data: { consumed_at: consumedAt }
      });

      return mapStateRowToRecord(updated);
    } catch {
      return null;
    }
  }

  async deleteExpired(before: string): Promise<number> {
    return this.adapter.deleteMany({
      model: this.model,
      where: [{ field: "expires_at", operator: "lt", value: before }]
    });
  }
}

export class DbAdapterTokenVault implements TokenVault {
  private readonly adapter: Adapter;
  private readonly model: string;

  constructor(adapter: Adapter, model = DEFAULT_MODELS.oauthTokenVault) {
    this.adapter = adapter;
    this.model = model;
  }

  async put(record: TokenRecord): Promise<void> {
    await this.adapter.upsert({
      model: this.model,
      where: [{ field: "token_id", operator: "eq", value: record.tokenId }],
      create: mapTokenRecordToRow(record),
      update: mapTokenRecordToRow(record),
      conflictTarget: "token_id"
    });
  }

  async get(tokenId: string): Promise<TokenRecord | null> {
    const row = await this.adapter.findOne<TokenRow>({
      model: this.model,
      where: [{ field: "token_id", operator: "eq", value: tokenId }]
    });

    return row ? mapTokenRowToRecord(row) : null;
  }

  async getByConnection(connectionId: string): Promise<TokenRecord | null> {
    const row = await this.adapter.findOne<TokenRow>({
      model: this.model,
      where: [{ field: "connection_id", operator: "eq", value: connectionId }]
    });

    return row ? mapTokenRowToRecord(row) : null;
  }

  async rotateKey(tokenId: string, newKeyRef: string): Promise<void> {
    try {
      await this.adapter.update({
        model: this.model,
        where: [{ field: "token_id", operator: "eq", value: tokenId }],
        data: {
          key_ref: newKeyRef,
          updated_at: new Date().toISOString()
        }
      });
    } catch {
      return;
    }
  }

  async deleteByConnection(connectionId: string): Promise<void> {
    await this.adapter.deleteMany({
      model: this.model,
      where: [{ field: "connection_id", operator: "eq", value: connectionId }]
    });
  }
}

export function createOAuthDbStorage(options: OAuthDbAdapterOptions): {
  stateStore: OAuthStateStore;
  tokenVault: TokenVault;
  models: OAuthDbModelMapping;
} {
  const models = resolveModelMapping(options.models);
  return {
    stateStore: new DbAdapterOAuthStateStore(options.adapter, models.oauthStates),
    tokenVault: new DbAdapterTokenVault(options.adapter, models.oauthTokenVault),
    models
  };
}

function resolveModelMapping(mapping: Partial<OAuthDbModelMapping> | undefined): OAuthDbModelMapping {
  const models: OAuthDbModelMapping = {
    oauthStates: mapping?.oauthStates ?? DEFAULT_MODELS.oauthStates,
    oauthTokenVault: mapping?.oauthTokenVault ?? DEFAULT_MODELS.oauthTokenVault
  };

  if (!models.oauthStates) {
    throw new OAuthDbAdapterError("SCHEMA_MISSING", "oauth_states model mapping required");
  }

  if (!models.oauthTokenVault) {
    throw new OAuthDbAdapterError("SCHEMA_MISSING", "oauth_token_vault model mapping required");
  }

  return models;
}

function mapStateRecordToRow(record: OAuthStateRecord): StateRow {
  return {
    state_id: record.stateId,
    tenant_id: record.tenantId,
    user_id: record.userId,
    provider_id: record.providerId,
    redirect_uri: record.redirectUri,
    requested_scopes: JSON.stringify(record.requestedScopes),
    code_verifier: record.codeVerifier ?? null,
    nonce: record.nonce ?? null,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    consumed_at: record.consumedAt ?? null
  };
}

function mapStateRowToRecord(row: StateRow): OAuthStateRecord {
  return {
    stateId: row.state_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    providerId: row.provider_id,
    redirectUri: row.redirect_uri,
    requestedScopes: JSON.parse(row.requested_scopes) as string[],
    codeVerifier: row.code_verifier ?? undefined,
    nonce: row.nonce ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? undefined
  };
}

function mapTokenRecordToRow(record: TokenRecord): TokenRow {
  return {
    token_id: record.tokenId,
    tenant_id: record.tenantId,
    user_id: record.userId,
    provider_id: record.providerId,
    connection_id: record.connectionId,
    encrypted_payload: record.encryptedPayload,
    key_ref: record.keyRef,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    expires_at: record.expiresAt ?? null
  };
}

function mapTokenRowToRecord(row: TokenRow): TokenRecord {
  return {
    tokenId: row.token_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    providerId: row.provider_id,
    connectionId: row.connection_id,
    encryptedPayload: row.encrypted_payload,
    keyRef: row.key_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? undefined
  };
}
