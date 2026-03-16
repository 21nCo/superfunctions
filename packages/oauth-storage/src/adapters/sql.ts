import type { OAuthStateRecord, OAuthStateStore, TokenRecord, TokenVault } from "../index.js";

export interface SqlResult {
  rowsAffected?: number;
}

export interface SqlClient {
  query<TRow = unknown>(
    statement: string,
    params?: readonly unknown[]
  ): Promise<TRow[]>;
  execute(statement: string, params?: readonly unknown[]): Promise<SqlResult>;
}

interface OAuthStateRow {
  state_id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  redirect_uri: string;
  requested_scopes: string;
  code_verifier: string | null;
  nonce: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

interface TokenRow {
  token_id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  connection_id: string;
  encrypted_payload: string;
  key_ref: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

const STATE_COLUMNS = `
  state_id,
  tenant_id,
  user_id,
  provider_id,
  redirect_uri,
  requested_scopes,
  code_verifier,
  nonce,
  created_at,
  expires_at,
  consumed_at
`;

const TOKEN_COLUMNS = `
  token_id,
  tenant_id,
  user_id,
  provider_id,
  connection_id,
  encrypted_payload,
  key_ref,
  created_at,
  updated_at,
  expires_at
`;

export class SqlOAuthStateStore implements OAuthStateStore {
  private readonly client: SqlClient;
  private readonly tableName: string;

  constructor(client: SqlClient, tableName = "oauth_states") {
    this.client = client;
    this.tableName = tableName;
  }

  async put(record: OAuthStateRecord): Promise<void> {
    await this.client.execute(
      `
      INSERT INTO ${this.tableName} (
        state_id,
        tenant_id,
        user_id,
        provider_id,
        redirect_uri,
        requested_scopes,
        code_verifier,
        nonce,
        created_at,
        expires_at,
        consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(state_id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        user_id = excluded.user_id,
        provider_id = excluded.provider_id,
        redirect_uri = excluded.redirect_uri,
        requested_scopes = excluded.requested_scopes,
        code_verifier = excluded.code_verifier,
        nonce = excluded.nonce,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        consumed_at = excluded.consumed_at
      `,
      [
        record.stateId,
        record.tenantId,
        record.userId,
        record.providerId,
        record.redirectUri,
        JSON.stringify(record.requestedScopes),
        record.codeVerifier ?? null,
        record.nonce ?? null,
        record.createdAt,
        record.expiresAt,
        record.consumedAt ?? null
      ]
    );
  }

  async get(stateId: string): Promise<OAuthStateRecord | null> {
    const rows = await this.client.query<OAuthStateRow>(
      `SELECT ${STATE_COLUMNS} FROM ${this.tableName} WHERE state_id = ? LIMIT 1`,
      [stateId]
    );

    return rows[0] ? mapStateRow(rows[0]) : null;
  }

  async consume(stateId: string, consumedAt: string): Promise<OAuthStateRecord | null> {
    const rows = await this.client.query<OAuthStateRow>(
      `
      UPDATE ${this.tableName}
      SET consumed_at = ?
      WHERE state_id = ?
        AND consumed_at IS NULL
        AND expires_at > ?
      RETURNING ${STATE_COLUMNS}
      `,
      [consumedAt, stateId, consumedAt]
    );

    return rows[0] ? mapStateRow(rows[0]) : null;
  }

  async deleteExpired(before: string): Promise<number> {
    const result = await this.client.execute(`DELETE FROM ${this.tableName} WHERE expires_at < ?`, [before]);
    return result.rowsAffected ?? 0;
  }
}

export class SqlTokenVault implements TokenVault {
  private readonly client: SqlClient;
  private readonly tableName: string;

  constructor(client: SqlClient, tableName = "oauth_token_vault") {
    this.client = client;
    this.tableName = tableName;
  }

  async put(record: TokenRecord): Promise<void> {
    await this.client.execute(
      `
      INSERT INTO ${this.tableName} (
        token_id,
        tenant_id,
        user_id,
        provider_id,
        connection_id,
        encrypted_payload,
        key_ref,
        created_at,
        updated_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        user_id = excluded.user_id,
        provider_id = excluded.provider_id,
        connection_id = excluded.connection_id,
        encrypted_payload = excluded.encrypted_payload,
        key_ref = excluded.key_ref,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
      `,
      [
        record.tokenId,
        record.tenantId,
        record.userId,
        record.providerId,
        record.connectionId,
        record.encryptedPayload,
        record.keyRef,
        record.createdAt,
        record.updatedAt,
        record.expiresAt ?? null
      ]
    );
  }

  async get(tokenId: string): Promise<TokenRecord | null> {
    const rows = await this.client.query<TokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM ${this.tableName} WHERE token_id = ? LIMIT 1`,
      [tokenId]
    );

    return rows[0] ? mapTokenRow(rows[0]) : null;
  }

  async getByConnection(connectionId: string): Promise<TokenRecord | null> {
    const rows = await this.client.query<TokenRow>(
      `SELECT ${TOKEN_COLUMNS} FROM ${this.tableName} WHERE connection_id = ? LIMIT 1`,
      [connectionId]
    );

    return rows[0] ? mapTokenRow(rows[0]) : null;
  }

  async rotateKey(tokenId: string, newKeyRef: string): Promise<void> {
    await this.client.execute(
      `UPDATE ${this.tableName} SET key_ref = ?, updated_at = ? WHERE token_id = ?`,
      [newKeyRef, new Date().toISOString(), tokenId]
    );
  }

  async deleteByConnection(connectionId: string): Promise<void> {
    await this.client.execute(`DELETE FROM ${this.tableName} WHERE connection_id = ?`, [connectionId]);
  }
}

export function getOAuthStorageSchema(
  stateTable = "oauth_states",
  tokenTable = "oauth_token_vault"
): ReadonlyArray<string> {
  return [
    `
    CREATE TABLE IF NOT EXISTS ${stateTable} (
      state_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      requested_scopes TEXT NOT NULL,
      code_verifier TEXT,
      nonce TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    )
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_${stateTable}_expires_at
    ON ${stateTable}(expires_at)
    `,
    `
    CREATE TABLE IF NOT EXISTS ${tokenTable} (
      token_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      connection_id TEXT NOT NULL UNIQUE,
      encrypted_payload TEXT NOT NULL,
      key_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT
    )
    `,
    `
    CREATE INDEX IF NOT EXISTS idx_${tokenTable}_connection
    ON ${tokenTable}(connection_id)
    `
  ];
}

function mapStateRow(row: OAuthStateRow): OAuthStateRecord {
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

function mapTokenRow(row: TokenRow): TokenRecord {
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
