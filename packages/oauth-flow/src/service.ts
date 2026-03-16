import { randomUUID } from "node:crypto";
import {
  DefaultOAuthService,
  OAuthCoreError,
  assertRedirectUriAllowed,
  type AuthorizationResult,
  type OAuthProviderDescriptor,
  type OAuthTokenSet
} from "@superfunctions/oauth-core";
import { OAuthHttpError, type OAuthTokenEndpointResponse } from "@superfunctions/oauth-http";
import { DefaultOAuthTokenHttpClient, type OAuthTokenHttpClient } from "@superfunctions/oauth-http";
import type {
  EncryptedTokenVault,
  OAuthStateRecord,
  OAuthStateStore,
  TokenRecord,
  TokenVault
} from "@superfunctions/oauth-storage";

export type OAuthFlowSubject = {
  tenantId: string;
  userId: string;
  connectionId?: string;
};

export type OAuthFlowStartInput = OAuthFlowSubject & {
  providerId: string;
  redirectUri: string;
  scopes?: string[];
  prompt?: string;
  loginHint?: string;
  metadata?: Record<string, unknown>;
};

export type OAuthFlowCallbackInput = {
  providerId?: string;
  code: string;
  state: string;
  redirectUri: string;
};

export type OAuthFlowRefreshInput = {
  connectionId: string;
  providerId: string;
  redirectUri: string;
  scopes?: string[];
};

export type OAuthFlowDisconnectInput = {
  connectionId: string;
  providerId: string;
  revokeRemote?: boolean;
  tokenTypeHint?: "access_token" | "refresh_token";
};

export type OAuthFlowStartResult = AuthorizationResult & {
  providerId: string;
};

export type OAuthFlowCallbackResult = {
  providerId: string;
  subject: OAuthFlowSubject;
  tokenSet: OAuthTokenSet;
  tokenRecordId: string;
  connectionId: string;
};

export type OAuthFlowDisconnectResult = {
  disconnected: boolean;
  remoteRevokeAttempted: boolean;
  localTokenDeleted: boolean;
  connectionDeleted: boolean;
};

export type OAuthFlowIdentityHooks = {
  onConnected?: (result: OAuthFlowCallbackResult) => Promise<void>;
  onDisconnected?: (input: OAuthFlowDisconnectInput) => Promise<void>;
};

export interface OAuthFlowService {
  start(input: OAuthFlowStartInput): Promise<OAuthFlowStartResult>;
  handleCallback(input: OAuthFlowCallbackInput): Promise<OAuthFlowCallbackResult>;
  refresh(input: OAuthFlowRefreshInput): Promise<OAuthTokenSet>;
  disconnect(input: OAuthFlowDisconnectInput): Promise<OAuthFlowDisconnectResult>;
}

export type OAuthProviderRuntimeConfig = {
  clientId: string;
  clientSecret: string;
  allowlistedRedirectUris?: string[];
};

export type OAuthFlowEventName =
  | "oauth.flow.started"
  | "oauth.flow.start.failed"
  | "oauth.flow.callback.success"
  | "oauth.flow.callback.failed"
  | "oauth.flow.refresh.success"
  | "oauth.flow.refresh.failed"
  | "oauth.flow.disconnect.success"
  | "oauth.flow.disconnect.failed";

export type OAuthFlowEvent = {
  name: OAuthFlowEventName;
  requestId: string;
  providerId: string;
  at: string;
  ok: boolean;
  errorCode?: OAuthFlowErrorCode;
};

export type OAuthFlowServiceConfig = {
  providers: Record<string, OAuthProviderDescriptor>;
  providerRuntimeConfig: Record<string, OAuthProviderRuntimeConfig>;
  stateStore: OAuthStateStore;
  tokenVault: TokenVault | EncryptedTokenVault;
  tokenHttpClient?: OAuthTokenHttpClient;
  identityHooks?: OAuthFlowIdentityHooks;
  keyRef?: string;
  now?: () => Date;
  emitEvent?: (event: OAuthFlowEvent) => void;
};

export type OAuthFlowErrorCode =
  | "HOOK_FAILED"
  | "NOT_IMPLEMENTED"
  | "OAUTH_STATE_INVALID"
  | "OAUTH_STATE_REPLAYED"
  | "OAUTH_CALLBACK_MISMATCH"
  | "OAUTH_TOKEN_REFRESH_FAILED"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export class OAuthFlowError extends Error {
  readonly code: OAuthFlowErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: OAuthFlowErrorCode,
    message: string,
    options?: { status?: number; retryable?: boolean; details?: Record<string, unknown> }
  ) {
    super(message);
    this.name = "OAuthFlowError";
    this.code = code;
    this.status = options?.status ?? 400;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

type OAuthFlowHookName = keyof OAuthFlowIdentityHooks;
type OAuthFlowHookPayloadMap = {
  onConnected: OAuthFlowCallbackResult;
  onDisconnected: OAuthFlowDisconnectInput;
};

export async function invokeIdentityHook<T extends OAuthFlowHookName>(
  hooks: OAuthFlowIdentityHooks | undefined,
  hookName: T,
  payload: OAuthFlowHookPayloadMap[T]
): Promise<void> {
  const hook = hooks?.[hookName];
  if (!hook) {
    return;
  }

  try {
    await hook(payload as never);
  } catch (error) {
    throw new OAuthFlowError("HOOK_FAILED", "identity hook failed", {
      status: 500,
      retryable: false,
      details: {
        hookName,
        cause: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

class DefaultOAuthFlowService implements OAuthFlowService {
  private readonly config: OAuthFlowServiceConfig;
  private readonly coreService: DefaultOAuthService;
  private readonly tokenHttpClient: OAuthTokenHttpClient;
  private readonly pendingConnectionByState = new Map<string, string>();
  private readonly now: () => Date;

  constructor(config: OAuthFlowServiceConfig) {
    this.config = config;
    this.now = config.now ?? (() => new Date());
    this.tokenHttpClient = config.tokenHttpClient ?? new DefaultOAuthTokenHttpClient();
    this.coreService = new DefaultOAuthService({
      providers: config.providers,
      providerRuntimeConfig: mapRuntimeConfig(config.providerRuntimeConfig),
      stateStore: config.stateStore,
      exchangeCodeForToken: async (input) => {
        const runtime = this.getRuntimeConfig(input.provider.id);
        const response = await this.tokenHttpClient.exchangeToken({
          provider: input.provider,
          grantType: "authorization_code",
          clientId: runtime.clientId,
          clientSecret: runtime.clientSecret,
          redirectUri: input.redirectUri,
          code: input.code,
          codeVerifier: input.codeVerifier,
          scopes: input.scopes
        });

        return {
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          expiresAt: response.expiresIn ? new Date(this.now().getTime() + response.expiresIn * 1000).toISOString() : undefined,
          scope: response.scope,
          tokenType: response.tokenType,
          idToken: response.idToken
        };
      },
      now: this.now
    });
  }

  async start(input: OAuthFlowStartInput): Promise<OAuthFlowStartResult> {
    const requestId = this.resolveRequestId(input.metadata);

    try {
      const provider = this.getProvider(input.providerId);
      const runtime = this.getRuntimeConfig(input.providerId);
      assertRedirectUriAllowed(input.redirectUri, runtime.allowlistedRedirectUris ?? []);

      const result = await this.coreService.createAuthorizationRequest({
        providerId: input.providerId,
        tenantId: input.tenantId,
        userId: input.userId,
        redirectUri: input.redirectUri,
        scopes: input.scopes,
        prompt: input.prompt,
        loginHint: input.loginHint
      });

      if (input.connectionId) {
        this.pendingConnectionByState.set(result.stateId, input.connectionId);
      }

      this.emitEvent({
        name: "oauth.flow.started",
        requestId,
        providerId: provider.id,
        at: this.now().toISOString(),
        ok: true
      });

      return {
        ...result,
        providerId: provider.id
      };
    } catch (error) {
      const mapped = mapToOAuthFlowError(error);
      this.emitEvent({
        name: "oauth.flow.start.failed",
        requestId,
        providerId: input.providerId,
        at: this.now().toISOString(),
        ok: false,
        errorCode: mapped.code
      });
      throw mapped;
    }
  }

  async handleCallback(input: OAuthFlowCallbackInput): Promise<OAuthFlowCallbackResult> {
    const requestId = randomUUID();
    const statePreview = await this.config.stateStore.get(input.state);
    const providerId = input.providerId ?? statePreview?.providerId;

    if (!providerId) {
      const error = new OAuthFlowError("OAUTH_STATE_INVALID", "OAuth state is invalid or expired", {
        status: 400,
        retryable: false
      });
      this.emitEvent({
        name: "oauth.flow.callback.failed",
        requestId,
        providerId: input.providerId ?? "unknown",
        at: this.now().toISOString(),
        ok: false,
        errorCode: error.code
      });
      throw error;
    }

    try {
      const tokenSet = await this.coreService.handleCallback({
        providerId,
        code: input.code,
        state: input.state,
        redirectUri: input.redirectUri
      });

      const consumedState = await this.requireState(input.state);
      const connectionId = this.pendingConnectionByState.get(input.state) ?? `conn_${input.state}`;
      this.pendingConnectionByState.delete(input.state);

      const tokenRecordId = await this.persistTokenSet({
        state: consumedState,
        providerId,
        connectionId,
        tokenSet
      });

      const result: OAuthFlowCallbackResult = {
        providerId,
        subject: {
          tenantId: consumedState.tenantId,
          userId: consumedState.userId,
          connectionId
        },
        tokenSet,
        tokenRecordId,
        connectionId
      };

      await invokeIdentityHook(this.config.identityHooks, "onConnected", result);

      this.emitEvent({
        name: "oauth.flow.callback.success",
        requestId,
        providerId,
        at: this.now().toISOString(),
        ok: true
      });

      return result;
    } catch (error) {
      const mapped = mapToOAuthFlowError(error);
      this.emitEvent({
        name: "oauth.flow.callback.failed",
        requestId,
        providerId,
        at: this.now().toISOString(),
        ok: false,
        errorCode: mapped.code
      });
      throw mapped;
    }
  }

  async refresh(input: OAuthFlowRefreshInput): Promise<OAuthTokenSet> {
    const requestId = randomUUID();

    try {
      const provider = this.getProvider(input.providerId);
      const runtime = this.getRuntimeConfig(input.providerId);
      const existing = await this.getTokenSetByConnection(input.connectionId);
      if (!existing) {
        throw new OAuthFlowError("OAUTH_TOKEN_REFRESH_FAILED", "OAuth token record not found for connection", {
          status: 404,
          retryable: false
        });
      }

      if (!existing.tokenSet.refreshToken) {
        throw new OAuthFlowError("OAUTH_TOKEN_REFRESH_FAILED", "refresh token is missing for connection", {
          status: 400,
          retryable: false
        });
      }

      const response = await this.tokenHttpClient.exchangeToken({
        provider,
        grantType: "refresh_token",
        clientId: runtime.clientId,
        clientSecret: runtime.clientSecret,
        refreshToken: existing.tokenSet.refreshToken,
        redirectUri: input.redirectUri,
        scopes: input.scopes
      });

      const merged = this.mergeRefreshTokenSet(existing.tokenSet, response);
      await this.persistRefreshedTokenSet(existing.record, merged);

      this.emitEvent({
        name: "oauth.flow.refresh.success",
        requestId,
        providerId: input.providerId,
        at: this.now().toISOString(),
        ok: true
      });

      return merged;
    } catch (error) {
      const mapped = mapToOAuthFlowError(error);
      this.emitEvent({
        name: "oauth.flow.refresh.failed",
        requestId,
        providerId: input.providerId,
        at: this.now().toISOString(),
        ok: false,
        errorCode: mapped.code
      });
      throw mapped;
    }
  }

  async disconnect(input: OAuthFlowDisconnectInput): Promise<OAuthFlowDisconnectResult> {
    const requestId = randomUUID();
    let remoteRevokeAttempted = false;
    let localTokenDeleted = false;
    let connectionDeleted = false;

    try {
      const provider = this.getProvider(input.providerId);
      const runtime = this.getRuntimeConfig(input.providerId);
      const tokenRecord = await this.getTokenSetByConnection(input.connectionId);
      const revokeRemote = input.revokeRemote ?? false;

      let revokeError: OAuthFlowError | null = null;
      if (revokeRemote && provider.revocationUrl && tokenRecord) {
        remoteRevokeAttempted = true;
        const tokenToRevoke = tokenRecord.tokenSet.refreshToken ?? tokenRecord.tokenSet.accessToken;
        try {
          await this.tokenHttpClient.revokeToken({
            provider,
            clientId: runtime.clientId,
            clientSecret: runtime.clientSecret,
            token: tokenToRevoke,
            tokenTypeHint: input.tokenTypeHint
          });
        } catch (error) {
          revokeError = mapToOAuthFlowError(error);
        }
      }

      await this.deleteTokenByConnection(input.connectionId);
      localTokenDeleted = tokenRecord !== null;
      connectionDeleted = true;

      await invokeIdentityHook(this.config.identityHooks, "onDisconnected", input);

      if (revokeError) {
        const errorWithFlags = new OAuthFlowError("INTERNAL_ERROR", "provider revoke failed after local cleanup", {
          status: 502,
          retryable: false,
          details: {
            remoteRevokeAttempted,
            localTokenDeleted,
            connectionDeleted
          }
        });
        this.emitEvent({
          name: "oauth.flow.disconnect.failed",
          requestId,
          providerId: input.providerId,
          at: this.now().toISOString(),
          ok: false,
          errorCode: errorWithFlags.code
        });
        throw errorWithFlags;
      }

      const result: OAuthFlowDisconnectResult = {
        disconnected: true,
        remoteRevokeAttempted,
        localTokenDeleted,
        connectionDeleted
      };

      this.emitEvent({
        name: "oauth.flow.disconnect.success",
        requestId,
        providerId: input.providerId,
        at: this.now().toISOString(),
        ok: true
      });

      return result;
    } catch (error) {
      if (error instanceof OAuthFlowError && error.code === "INTERNAL_ERROR") {
        throw error;
      }

      const mapped = mapToOAuthFlowError(error);
      this.emitEvent({
        name: "oauth.flow.disconnect.failed",
        requestId,
        providerId: input.providerId,
        at: this.now().toISOString(),
        ok: false,
        errorCode: mapped.code
      });
      throw mapped;
    }
  }

  private mergeRefreshTokenSet(existing: OAuthTokenSet, response: OAuthTokenEndpointResponse): OAuthTokenSet {
    return {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken ?? existing.refreshToken,
      expiresAt: response.expiresIn ? new Date(this.now().getTime() + response.expiresIn * 1000).toISOString() : existing.expiresAt,
      scope: response.scope ?? existing.scope,
      tokenType: response.tokenType ?? existing.tokenType,
      idToken: response.idToken ?? existing.idToken
    };
  }

  private async persistTokenSet(input: {
    state: OAuthStateRecord;
    providerId: string;
    connectionId: string;
    tokenSet: OAuthTokenSet;
  }): Promise<string> {
    const timestamp = this.now().toISOString();
    const tokenId = `tok_${randomUUID()}`;
    const keyRef = this.config.keyRef ?? "oauth-default";

    if (isEncryptedTokenVault(this.config.tokenVault)) {
      await this.config.tokenVault.putTokenSet({
        tokenId,
        tenantId: input.state.tenantId,
        userId: input.state.userId,
        providerId: input.providerId,
        connectionId: input.connectionId,
        tokenSet: {
          accessToken: input.tokenSet.accessToken,
          refreshToken: input.tokenSet.refreshToken,
          expiresAt: input.tokenSet.expiresAt,
          scope: input.tokenSet.scope,
          tokenType: input.tokenSet.tokenType,
          idToken: input.tokenSet.idToken
        },
        keyRef,
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: input.tokenSet.expiresAt
      });
      return tokenId;
    }

    const record: TokenRecord = {
      tokenId,
      tenantId: input.state.tenantId,
      userId: input.state.userId,
      providerId: input.providerId,
      connectionId: input.connectionId,
      encryptedPayload: JSON.stringify(input.tokenSet),
      keyRef,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: input.tokenSet.expiresAt
    };

    await this.config.tokenVault.put(record);
    return tokenId;
  }

  private async requireState(stateId: string): Promise<OAuthStateRecord> {
    const state = await this.config.stateStore.get(stateId);
    if (!state) {
      throw new OAuthFlowError("OAUTH_STATE_INVALID", "OAuth state is invalid or expired", {
        status: 400,
        retryable: false
      });
    }

    return state;
  }

  private getProvider(providerId: string): OAuthProviderDescriptor {
    const provider = this.config.providers[providerId];
    if (!provider) {
      throw new OAuthFlowError("VALIDATION_ERROR", `Unknown OAuth provider: ${providerId}`, {
        status: 400,
        retryable: false
      });
    }

    return provider;
  }

  private getRuntimeConfig(providerId: string): OAuthProviderRuntimeConfig {
    const runtime = this.config.providerRuntimeConfig[providerId];
    if (!runtime) {
      throw new OAuthFlowError("VALIDATION_ERROR", `Missing runtime OAuth config for provider: ${providerId}`, {
        status: 400,
        retryable: false
      });
    }

    return runtime;
  }

  private resolveRequestId(metadata: Record<string, unknown> | undefined): string {
    const requestId = metadata?.requestId;
    return typeof requestId === "string" && requestId.length > 0 ? requestId : randomUUID();
  }

  private emitEvent(event: OAuthFlowEvent): void {
    this.config.emitEvent?.(event);
  }

  private async getTokenSetByConnection(connectionId: string): Promise<{ record: TokenRecord; tokenSet: OAuthTokenSet } | null> {
    if (isEncryptedTokenVault(this.config.tokenVault)) {
      const decrypted = await this.config.tokenVault.getTokenSetByConnection(connectionId);
      if (!decrypted) {
        return null;
      }

      return {
        record: decrypted.record,
        tokenSet: decrypted.tokenSet
      };
    }

    const record = await this.config.tokenVault.getByConnection(connectionId);
    if (!record) {
      return null;
    }

    return {
      record,
      tokenSet: parseTokenPayload(record.encryptedPayload)
    };
  }

  private async persistRefreshedTokenSet(existing: TokenRecord, tokenSet: OAuthTokenSet): Promise<void> {
    const updatedAt = this.now().toISOString();
    if (isEncryptedTokenVault(this.config.tokenVault)) {
      await this.config.tokenVault.putTokenSet({
        tokenId: existing.tokenId,
        tenantId: existing.tenantId,
        userId: existing.userId,
        providerId: existing.providerId,
        connectionId: existing.connectionId,
        tokenSet: {
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          expiresAt: tokenSet.expiresAt,
          scope: tokenSet.scope,
          tokenType: tokenSet.tokenType,
          idToken: tokenSet.idToken
        },
        keyRef: existing.keyRef,
        createdAt: existing.createdAt,
        updatedAt,
        expiresAt: tokenSet.expiresAt
      });
      return;
    }

    await this.config.tokenVault.put({
      ...existing,
      encryptedPayload: JSON.stringify(tokenSet),
      updatedAt,
      expiresAt: tokenSet.expiresAt
    });
  }

  private async deleteTokenByConnection(connectionId: string): Promise<void> {
    await this.config.tokenVault.deleteByConnection(connectionId);
  }
}

function mapRuntimeConfig(
  runtimeConfig: Record<string, OAuthProviderRuntimeConfig>
): Record<string, { clientId: string; allowlistedRedirectUris?: string[] }> {
  const mapped: Record<string, { clientId: string; allowlistedRedirectUris?: string[] }> = {};

  for (const [providerId, runtime] of Object.entries(runtimeConfig)) {
    mapped[providerId] = {
      clientId: runtime.clientId,
      allowlistedRedirectUris: runtime.allowlistedRedirectUris
    };
  }

  return mapped;
}

function mapToOAuthFlowError(error: unknown): OAuthFlowError {
  if (error instanceof OAuthFlowError) {
    return error;
  }

  if (error instanceof OAuthCoreError) {
    return new OAuthFlowError(error.code, error.message, {
      status: error.status,
      retryable: error.retryable,
      details: sanitizeDetails(error.details)
    });
  }

  if (error instanceof OAuthHttpError) {
    return new OAuthFlowError(error.code as OAuthFlowErrorCode, error.message, {
      status: error.status,
      retryable: error.retryable,
      details: sanitizeDetails(error.details)
    });
  }

  return new OAuthFlowError("INTERNAL_ERROR", "Unexpected OAuth flow error", {
    status: 500,
    retryable: false
  });
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const lower = key.toLowerCase();
    if (lower.includes("token") || lower.includes("secret") || lower.includes("authorization")) {
      continue;
    }
    copy[key] = value;
  }
  return copy;
}

function isEncryptedTokenVault(vault: TokenVault | EncryptedTokenVault): vault is EncryptedTokenVault {
  return typeof (vault as EncryptedTokenVault).putTokenSet === "function";
}

function parseTokenPayload(payload: string): OAuthTokenSet {
  try {
    const parsed = JSON.parse(payload) as Partial<OAuthTokenSet>;
    if (!parsed.accessToken || typeof parsed.accessToken !== "string") {
      throw new Error("missing access token");
    }

    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      scope: parsed.scope,
      tokenType: parsed.tokenType,
      idToken: parsed.idToken
    };
  } catch {
    throw new OAuthFlowError("INTERNAL_ERROR", "stored token payload is invalid", {
      status: 500,
      retryable: false
    });
  }
}

export function createOAuthFlowService(config: OAuthFlowServiceConfig): OAuthFlowService {
  return new DefaultOAuthFlowService(config);
}
