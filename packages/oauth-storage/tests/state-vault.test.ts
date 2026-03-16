import { describe, expect, it } from "vitest";
import {
  AesGcmTokenCipher,
  EncryptedTokenVault,
  MemoryOAuthStateStore,
  MemoryTokenVault,
  SqlOAuthStateStore,
  type SqlClient
} from "../src/index.js";

type StateRow = {
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
  expires_at: string | null;
};

class InMemorySqlClient implements SqlClient {
  private readonly states = new Map<string, StateRow>();
  private readonly tokens = new Map<string, TokenRow>();

  async query<TRow = unknown>(
    statement: string,
    params: readonly unknown[] = []
  ): Promise<TRow[]> {
    const normalized = normalizeSql(statement);

    if (normalized.startsWith("SELECT") && normalized.includes("FROM OAUTH_STATES")) {
      const stateId = params[0] as string;
      const row = this.states.get(stateId);
      return (row ? [row] : []) as TRow[];
    }

    if (normalized.startsWith("UPDATE OAUTH_STATES")) {
      const consumedAt = params[0] as string;
      const stateId = params[1] as string;
      const cutoff = params[2] as string;
      const row = this.states.get(stateId);
      if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.parse(cutoff)) {
        return [] as TRow[];
      }

      const updated: StateRow = { ...row, consumed_at: consumedAt };
      this.states.set(stateId, updated);
      return [updated] as TRow[];
    }

    if (normalized.startsWith("SELECT") && normalized.includes("FROM OAUTH_TOKEN_VAULT")) {
      if (normalized.includes("WHERE TOKEN_ID")) {
        const tokenId = params[0] as string;
        const row = this.tokens.get(tokenId);
        return (row ? [row] : []) as TRow[];
      }

      const connectionId = params[0] as string;
      const row = [...this.tokens.values()].find((candidate) => candidate.connection_id === connectionId);
      return (row ? [row] : []) as TRow[];
    }

    return [] as TRow[];
  }

  async execute(statement: string, params: readonly unknown[] = []): Promise<{ rowsAffected?: number }> {
    const normalized = normalizeSql(statement);

    if (normalized.startsWith("INSERT INTO OAUTH_STATES")) {
      const row: StateRow = {
        state_id: params[0] as string,
        tenant_id: params[1] as string,
        user_id: params[2] as string,
        provider_id: params[3] as string,
        redirect_uri: params[4] as string,
        requested_scopes: params[5] as string,
        code_verifier: (params[6] as string | null) ?? null,
        nonce: (params[7] as string | null) ?? null,
        created_at: params[8] as string,
        expires_at: params[9] as string,
        consumed_at: (params[10] as string | null) ?? null
      };
      this.states.set(row.state_id, row);
      return { rowsAffected: 1 };
    }

    if (normalized.startsWith("DELETE FROM OAUTH_STATES")) {
      const before = params[0] as string;
      let deleted = 0;

      for (const [stateId, row] of this.states.entries()) {
        if (Date.parse(row.expires_at) < Date.parse(before)) {
          this.states.delete(stateId);
          deleted += 1;
        }
      }

      return { rowsAffected: deleted };
    }

    if (normalized.startsWith("INSERT INTO OAUTH_TOKEN_VAULT")) {
      const row: TokenRow = {
        token_id: params[0] as string,
        tenant_id: params[1] as string,
        user_id: params[2] as string,
        provider_id: params[3] as string,
        connection_id: params[4] as string,
        encrypted_payload: params[5] as string,
        key_ref: params[6] as string,
        created_at: params[7] as string,
        updated_at: params[8] as string,
        expires_at: (params[9] as string | null) ?? null
      };
      this.tokens.set(row.token_id, row);
      return { rowsAffected: 1 };
    }

    if (normalized.startsWith("UPDATE OAUTH_TOKEN_VAULT SET KEY_REF")) {
      const newKeyRef = params[0] as string;
      const updatedAt = params[1] as string;
      const tokenId = params[2] as string;
      const row = this.tokens.get(tokenId);
      if (!row) {
        return { rowsAffected: 0 };
      }

      this.tokens.set(tokenId, {
        ...row,
        key_ref: newKeyRef,
        updated_at: updatedAt
      });
      return { rowsAffected: 1 };
    }

    if (normalized.startsWith("DELETE FROM OAUTH_TOKEN_VAULT")) {
      const connectionId = params[0] as string;
      const token = [...this.tokens.values()].find((candidate) => candidate.connection_id === connectionId);
      if (!token) {
        return { rowsAffected: 0 };
      }

      this.tokens.delete(token.token_id);
      return { rowsAffected: 1 };
    }

    return { rowsAffected: 0 };
  }
}

describe("oauth-storage state and vault", () => {
  it("supports durable state consumption across store instances with SQL adapter", async () => {
    const sql = new InMemorySqlClient();
    const storeA = new SqlOAuthStateStore(sql);
    const storeB = new SqlOAuthStateStore(sql);

    await storeA.put({
      stateId: "st_123",
      tenantId: "t1",
      userId: "u1",
      providerId: "google",
      redirectUri: "https://app/callback",
      requestedScopes: ["openid"],
      codeVerifier: "verifier",
      nonce: "nonce",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:10:00.000Z"
    });

    const recovered = await storeB.get("st_123");
    expect(recovered?.stateId).toBe("st_123");

    const consumed = await storeB.consume("st_123", "2026-01-01T00:01:00.000Z");
    expect(consumed?.consumedAt).toBe("2026-01-01T00:01:00.000Z");

    const replay = await storeA.consume("st_123", "2026-01-01T00:02:00.000Z");
    expect(replay).toBeNull();
  });

  it("purges expired states and blocks expired consumption", async () => {
    const store = new MemoryOAuthStateStore();
    await store.put({
      stateId: "st_expired",
      tenantId: "t1",
      userId: "u1",
      providerId: "google",
      redirectUri: "https://app/callback",
      requestedScopes: ["openid"],
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:00.000Z"
    });

    const consumeExpired = await store.consume("st_expired", "2026-01-01T00:02:00.000Z");
    expect(consumeExpired).toBeNull();

    const removed = await store.deleteExpired("2026-01-01T00:02:00.000Z");
    expect(removed).toBe(1);
    expect(await store.get("st_expired")).toBeNull();
  });

  it("stores encrypted token payloads and never stores plaintext in token records", async () => {
    const backingStore = new MemoryTokenVault();
    const keys = createKeyResolver({
      "kms-key-1": Buffer.from("11".repeat(32), "hex")
    });
    const cipher = new AesGcmTokenCipher(keys);
    const vault = new EncryptedTokenVault(backingStore, cipher, () => "2026-01-01T00:00:00.000Z");

    await vault.putTokenSet({
      tokenId: "tok_1",
      tenantId: "t1",
      userId: "u1",
      providerId: "google",
      connectionId: "conn_1",
      keyRef: "kms-key-1",
      tokenSet: {
        accessToken: "at_plaintext",
        refreshToken: "rt_plaintext",
        tokenType: "bearer"
      }
    });

    const raw = await backingStore.get("tok_1");
    expect(raw).not.toBeNull();
    expect(raw?.encryptedPayload).not.toContain("at_plaintext");
    expect(raw?.encryptedPayload).not.toContain("rt_plaintext");
    expect(raw?.keyRef).toBe("kms-key-1");

    const decrypted = await vault.getTokenSet("tok_1");
    expect(decrypted?.tokenSet.accessToken).toBe("at_plaintext");
    expect(decrypted?.tokenSet.refreshToken).toBe("rt_plaintext");
  });

  it("fails safely when key material is unavailable during decrypt", async () => {
    const backingStore = new MemoryTokenVault();
    const writeCipher = new AesGcmTokenCipher(
      createKeyResolver({
        "kms-key-1": Buffer.from("22".repeat(32), "hex")
      })
    );
    const writeVault = new EncryptedTokenVault(backingStore, writeCipher, () => "2026-01-01T00:00:00.000Z");

    await writeVault.putTokenSet({
      tokenId: "tok_missing_key",
      tenantId: "t1",
      userId: "u1",
      providerId: "google",
      connectionId: "conn_missing_key",
      keyRef: "kms-key-1",
      tokenSet: {
        accessToken: "at",
        refreshToken: "rt"
      }
    });

    const readCipher = new AesGcmTokenCipher(createKeyResolver({}));
    const readVault = new EncryptedTokenVault(backingStore, readCipher);

    await expect(readVault.getTokenSet("tok_missing_key")).rejects.toMatchObject({
      code: "INTERNAL_ERROR"
    });
  });

  it("re-encrypts token payload during key rotation without losing token semantics", async () => {
    const backingStore = new MemoryTokenVault();
    const cipher = new AesGcmTokenCipher(
      createKeyResolver({
        "kms-key-1": Buffer.from("33".repeat(32), "hex"),
        "kms-key-2": Buffer.from("44".repeat(32), "hex")
      })
    );
    const vault = new EncryptedTokenVault(backingStore, cipher, () => "2026-01-01T00:00:00.000Z");

    await vault.putTokenSet({
      tokenId: "tok_rotate",
      tenantId: "t1",
      userId: "u1",
      providerId: "google",
      connectionId: "conn_rotate",
      keyRef: "kms-key-1",
      tokenSet: {
        accessToken: "at_rotate",
        refreshToken: "rt_rotate",
        tokenType: "bearer"
      }
    });

    const beforeRotate = await backingStore.get("tok_rotate");
    expect(beforeRotate).not.toBeNull();

    await vault.rotateKey("tok_rotate", "kms-key-2");

    const afterRotate = await backingStore.get("tok_rotate");
    expect(afterRotate?.keyRef).toBe("kms-key-2");
    expect(afterRotate?.encryptedPayload).not.toBe(beforeRotate?.encryptedPayload);

    const decrypted = await vault.getTokenSet("tok_rotate");
    expect(decrypted?.tokenSet.accessToken).toBe("at_rotate");
    expect(decrypted?.tokenSet.refreshToken).toBe("rt_rotate");
  });

  it("rejects persistence when keyRef is missing", async () => {
    const backingStore = new MemoryTokenVault();
    const cipher = new AesGcmTokenCipher(
      createKeyResolver({
        "kms-key-1": Buffer.from("55".repeat(32), "hex")
      })
    );
    const vault = new EncryptedTokenVault(backingStore, cipher);

    await expect(
      vault.putTokenSet({
        tokenId: "tok_invalid",
        tenantId: "t1",
        userId: "u1",
        providerId: "google",
        connectionId: "conn_invalid",
        keyRef: "",
        tokenSet: {
          accessToken: "at",
          refreshToken: "rt"
        }
      })
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "keyRef is required"
    });
  });
});

function createKeyResolver(map: Record<string, Buffer>) {
  return async (keyRef: string): Promise<Buffer> => {
    const key = map[keyRef];
    if (!key) {
      throw new Error(`missing key: ${keyRef}`);
    }

    return key;
  };
}

function normalizeSql(statement: string): string {
  return statement.replace(/\s+/g, " ").trim().toUpperCase();
}
