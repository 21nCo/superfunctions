import { randomUUID } from "node:crypto";
import {
  DefaultOAuthService,
  OAuthCoreError,
  type AuthorizationResult,
  type OAuthProviderDescriptor,
  type OAuthTokenSet
} from "@superfunctions/oauth-core";
import { DefaultOAuthTokenHttpClient, OAuthHttpError, type OAuthTokenEndpointResponse, type OAuthTokenHttpClient } from "@superfunctions/oauth-http";
import type {
  EncryptedTokenVault,
  OAuthStateRecord,
  OAuthStateStore,
  TokenRecord,
  TokenVault
} from "@superfunctions/oauth-storage";

type OAuthIntentSubject =
  | {
      kind: "connection";
      tenantId: string;
      userId: string;
      connectionId?: string;
    }
  | {
      kind: "browser-auth";
      intentId: string;
      tenantId?: string;
      regionId?: string;
      returnTo?: string;
      metadata?: Record<string, unknown>;
    };

type OAuthStoredStateRecord = OAuthStateRecord & {
  subject?: OAuthIntentSubject;
  connectionId?: string;
  intentId?: string;
  regionId?: string;
  returnTo?: string;
  metadata?: Record<string, unknown>;
};

type OAuthTokenGrantType = "authorization_code" | "refresh_token" | "client_credentials";
type OAuthTokenAuthMethod = "client_secret_post" | "client_secret_basic";

type OAuthResolvedClientSecret = {
  clientSecret: string;
  tokenAuthMethod?: OAuthTokenAuthMethod;
};

type OAuthSecretResolverContext = {
  provider: OAuthProviderDescriptor;
  operation: "exchange" | "revoke";
  clientId: string;
  grantType?: OAuthTokenGrantType;
  redirectUri?: string;
  scopes?: string[];
  tokenTypeHint?: "access_token" | "refresh_token";
};

type OAuthClientSecretResolver = (
  input: OAuthSecretResolverContext
) => Promise<OAuthResolvedClientSecret> | OAuthResolvedClientSecret;

type OAuthExchangeTokenInput = {
  provider: OAuthProviderDescriptor;
  grantType: OAuthTokenGrantType;
  clientId: string;
  clientSecret?: string;
  clientSecretResolver?: OAuthClientSecretResolver;
  redirectUri?: string;
  code?: string;
  codeVerifier?: string;
  refreshToken?: string;
  scopes?: string[];
};

type OAuthRevokeTokenInput = {
  provider: OAuthProviderDescriptor;
  clientId: string;
  clientSecret?: string;
  clientSecretResolver?: OAuthClientSecretResolver;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
};

type CreateAuthorizationRequestInput = {
  providerId: string;
  redirectUri: string;
  scopes?: string[];
  prompt?: string;
  loginHint?: string;
  subject: OAuthIntentSubject;
};

export interface OAuthFlowSubject {
  kind: "connection" | "browser-auth";
  tenantId?: string;
  userId?: string;
  connectionId?: string;
  intentId?: string;
  regionId?: string;
  returnTo?: string;
  metadata?: Record<string, unknown>;
}

export interface OAuthFlowResolvedIdentity {
  tenantId: string;
  userId: string;
  connectionId?: string;
  metadata?: Record<string, unknown>;
  persistTokens?: boolean;
}

export type OAuthFlowStartInput = {
  providerId: string;
  redirectUri: string;
  scopes?: string[];
  prompt?: string;
  loginHint?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
} & (
  | {
      subject: OAuthIntentSubject;
    }
  | {
      tenantId: string;
      userId: string;
      connectionId?: string;
    }
);

export type OAuthFlowCallbackInput = {
  providerId?: string;
  code: string;
  state: string;
  redirectUri: string;
  requestId?: string;
};

export type OAuthFlowRefreshInput = {
  connectionId: string;
  providerId: string;
  redirectUri: string;
  scopes?: string[];
  requestId?: string;
};

export type OAuthFlowDisconnectInput = {
  connectionId: string;
  providerId: string;
  revokeRemote?: boolean;
  tokenTypeHint?: "access_token" | "refresh_token";
  requestId?: string;
};

export type OAuthFlowStartResult = AuthorizationResult & {
  providerId: string;
};

export type OAuthFlowCallbackResult = {
  providerId: string;
  subject: OAuthFlowSubject;
  tokenSet: OAuthTokenSet;
  tokenRecordId?: string;
  connectionId?: string;
  resolvedIdentity?: OAuthFlowResolvedIdentity;
};

export type OAuthFlowDisconnectResult = {
  disconnected: boolean;
  remoteRevokeAttempted: boolean;
  localTokenDeleted: boolean;
  connectionDeleted: boolean;
};

export interface OAuthFlowResolveBrowserAuthIdentityInput {
  providerId: string;
  subject: OAuthFlowSubject;
  state: OAuthStateRecord;
  tokenSet: OAuthTokenSet;
}

export type OAuthFlowIdentityHooks = {
  resolveBrowserAuthIdentity?: (
    input: OAuthFlowResolveBrowserAuthIdentityInput
  ) => Promise<OAuthFlowResolvedIdentity | null> | OAuthFlowResolvedIdentity | null;
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
  clientSecret?: string;
  allowlistedRedirectUris?: string[];
  clientSecretResolver?: OAuthClientSecretResolver;
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
  subjectKind?: OAuthFlowSubject["kind"];
  connectionId?: string;
  errorCode?: OAuthFlowErrorCode;
  details?: Record<string, unknown>;
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
  | "OAUTH_HOOK_FAILED"
  | "NOT_IMPLEMENTED"
  | "OAUTH_STATE_INVALID"
  | "OAUTH_STATE_REPLAYED"
  | "OAUTH_CALLBACK_MISMATCH"
  | "OAUTH_REDIRECT_DISALLOWED"
  | "OAUTH_PROVIDER_UNSUPPORTED"
  | "OAUTH_RUNTIME_CONFIG_INVALID"
  | "OAUTH_SECRET_RESOLUTION_FAILED"
  | "OAUTH_TOKEN_REFRESH_FAILED"
  | "OAUTH_TOKEN_EXCHANGE_FAILED"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR"
  | "PROVIDER_RATE_LIMITED";

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

type HookPayloadMap = {
  resolveBrowserAuthIdentity: OAuthFlowResolveBrowserAuthIdentityInput;
  onConnected: OAuthFlowCallbackResult;
  onDisconnected: OAuthFlowDisconnectInput;
};

type HookName = keyof HookPayloadMap;

export async function invokeIdentityHook<T extends HookName>(
  hooks: OAuthFlowIdentityHooks | undefined,
  hookName: T,
  payload: HookPayloadMap[T]
): Promise<T extends "resolveBrowserAuthIdentity" ? OAuthFlowResolvedIdentity | null : void> {
  const hook = hooks?.[hookName] as ((value: HookPayloadMap[T]) => Promise<unknown> | unknown) | undefined;
  if (!hook) {
    return undefined as T extends "resolveBrowserAuthIdentity" ? OAuthFlowResolvedIdentity | null : void;
  }

  try {
    const result = await hook(payload);
    return result as T extends "resolveBrowserAuthIdentity" ? OAuthFlowResolvedIdentity | null : void;
  } catch (error) {
    throw new OAuthFlowError("OAUTH_HOOK_FAILED", "identity hook failed", {
      status: 500,
      retryable: false,
      details: sanitizeDetails({
        hookName,
        cause: error instanceof Error ? error.message : String(error)
      })
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
    const exchangeToken = this.tokenHttpClient.exchangeToken.bind(this.tokenHttpClient) as (
      input: OAuthExchangeTokenInput
    ) => Promise<OAuthTokenEndpointResponse>;
    this.coreService = new DefaultOAuthService({
      providers: config.providers,
      providerRuntimeConfig: mapRuntimeConfig(config.providerRuntimeConfig),
      stateStore: config.stateStore,
      exchangeCodeForToken: async (input) => {
        const runtime = this.getRuntimeConfig(input.provider.id);
        const response = await exchangeToken({
          provider: input.provider,
          grantType: "authorization_code",
          clientId: runtime.clientId,
          clientSecret: runtime.clientSecret,
          clientSecretResolver: runtime.clientSecretResolver,
          redirectUri: input.redirectUri,
          code: input.code,
          codeVerifier: input.codeVerifier,
          scopes: input.scopes
        });

        return {
          accessToken: response.accessToken,
          refreshToken: response.refreshToken,
          expiresAt: response.expiresIn
            ? new Date(this.now().getTime() + response.expiresIn * 1000).toISOString()
            : undefined,
          scope: response.scope,
          tokenType: response.tokenType,
          idToken: response.idToken
        };
      },
      now: this.now
    });
  }

  async start(input: OAuthFlowStartInput): Promise<OAuthFlowStartResult> {
    const requestId = this.resolveRequestId(input.requestId, input.metadata);
    const subject = normalizeStartSubject(input);

    try {
      const provider = this.getProvider(input.providerId);
      const createAuthorizationRequest = this.coreService.createAuthorizationRequest.bind(this.coreService) as unknown as (
        request: CreateAuthorizationRequestInput
      ) => Promise<AuthorizationResult>;
      const result = await createAuthorizationRequest({
        providerId: input.providerId,
        redirectUri: input.redirectUri,
        scopes: input.scopes,
        prompt: input.prompt,
        loginHint: input.loginHint,
        subject: toIntentSubject(subject)
      });

      if (subject.kind === "connection" && subject.connectionId) {
        this.pendingConnectionByState.set(result.stateId, subject.connectionId);
      }

      this.emitEvent({
        name: "oauth.flow.started",
        requestId,
        providerId: provider.id,
        at: this.now().toISOString(),
        ok: true,
        subjectKind: subject.kind,
        connectionId: subject.connectionId
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
        subjectKind: subject.kind,
        connectionId: subject.connectionId,
        errorCode: mapped.code,
        details: mapped.details
      });
      throw mapped;
    }
  }

  async handleCallback(input: OAuthFlowCallbackInput): Promise<OAuthFlowCallbackResult> {
    const requestId = input.requestId ?? randomUUID();
    const statePreview = await this.config.stateStore.get(input.state);
    const providerId = input.providerId ?? statePreview?.providerId;
    const subjectPreview = statePreview ? toFlowSubject(statePreview) : undefined;

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
        subjectKind: subjectPreview?.kind,
        connectionId: subjectPreview?.connectionId,
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
      const subject = toFlowSubject(consumedState);

      let connectionId: string | undefined;
      let tokenRecordId: string | undefined;
      let resolvedIdentity: OAuthFlowResolvedIdentity | undefined;

      if (subject.kind === "connection") {
        connectionId = this.pendingConnectionByState.get(input.state) ?? subject.connectionId ?? `conn_${input.state}`;
        this.pendingConnectionByState.delete(input.state);
        tokenRecordId = await this.persistTokenSet({
          state: consumedState,
          providerId,
          connectionId,
          tokenSet
        });
      } else {
        const hookResult = await invokeIdentityHook(this.config.identityHooks, "resolveBrowserAuthIdentity", {
          providerId,
          subject,
          state: consumedState,
          tokenSet
        });

        if (hookResult) {
          resolvedIdentity = cloneResolvedIdentity(hookResult);
          if (hookResult.persistTokens !== false) {
            connectionId = hookResult.connectionId ?? `conn_${input.state}`;
            tokenRecordId = await this.persistTokenSet({
              state: applyResolvedIdentity(consumedState, hookResult),
              providerId,
              connectionId,
              tokenSet
            });
          }
        }
      }

      const result: OAuthFlowCallbackResult = {
        providerId,
        subject,
        tokenSet,
        tokenRecordId,
        connectionId,
        resolvedIdentity
      };

      await invokeIdentityHook(this.config.identityHooks, "onConnected", result);

      this.emitEvent({
        name: "oauth.flow.callback.success",
        requestId,
        providerId,
        at: this.now().toISOString(),
        ok: true,
        subjectKind: subject.kind,
        connectionId
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
        subjectKind: subjectPreview?.kind,
        connectionId: subjectPreview?.connectionId,
        errorCode: mapped.code,
        details: mapped.details
      });
      throw mapped;
    }
  }

  async refresh(input: OAuthFlowRefreshInput): Promise<OAuthTokenSet> {
    const requestId = input.requestId ?? randomUUID();

    try {
      const exchangeToken = this.tokenHttpClient.exchangeToken.bind(this.tokenHttpClient) as (
        request: OAuthExchangeTokenInput
      ) => Promise<OAuthTokenEndpointResponse>;
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

      const response = await exchangeToken({
        provider,
        grantType: "refresh_token",
        clientId: runtime.clientId,
        clientSecret: runtime.clientSecret,
        clientSecretResolver: runtime.clientSecretResolver,
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
        ok: true,
        connectionId: input.connectionId
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
        connectionId: input.connectionId,
        errorCode: mapped.code,
        details: mapped.details
      });
      throw mapped;
    }
  }

  async disconnect(input: OAuthFlowDisconnectInput): Promise<OAuthFlowDisconnectResult> {
    const requestId = input.requestId ?? randomUUID();
    let remoteRevokeAttempted = false;
    let localTokenDeleted = false;
    let connectionDeleted = false;

    try {
      const revokeToken = this.tokenHttpClient.revokeToken.bind(this.tokenHttpClient) as (
        request: OAuthRevokeTokenInput
      ) => Promise<void>;
      const provider = this.getProvider(input.providerId);
      const runtime = this.getRuntimeConfig(input.providerId);
      const tokenRecord = await this.getTokenSetByConnection(input.connectionId);
      const revokeRemote = input.revokeRemote ?? false;

      let revokeError: OAuthFlowError | null = null;
      if (revokeRemote && provider.revocationUrl && tokenRecord) {
        remoteRevokeAttempted = true;
        const tokenToRevoke = tokenRecord.tokenSet.refreshToken ?? tokenRecord.tokenSet.accessToken;
        try {
          await revokeToken({
            provider,
            clientId: runtime.clientId,
            clientSecret: runtime.clientSecret,
            clientSecretResolver: runtime.clientSecretResolver,
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
          connectionId: input.connectionId,
          errorCode: errorWithFlags.code,
          details: errorWithFlags.details
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
        ok: true,
        connectionId: input.connectionId
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
        connectionId: input.connectionId,
        errorCode: mapped.code,
        details: mapped.details
      });
      throw mapped;
    }
  }

  private mergeRefreshTokenSet(existing: OAuthTokenSet, response: OAuthTokenEndpointResponse): OAuthTokenSet {
    return {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken ?? existing.refreshToken,
      expiresAt: response.expiresIn
        ? new Date(this.now().getTime() + response.expiresIn * 1000).toISOString()
        : existing.expiresAt,
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
    const tenantId = input.state.tenantId;
    const userId = input.state.userId;
    if (!tenantId || !userId) {
      throw new OAuthFlowError("OAUTH_RUNTIME_CONFIG_INVALID", "Token persistence requires resolved tenantId and userId", {
        status: 500,
        retryable: false
      });
    }

    const timestamp = this.now().toISOString();
    const tokenId = `tok_${randomUUID()}`;
    const keyRef = this.config.keyRef ?? "oauth-default";

    if (isEncryptedTokenVault(this.config.tokenVault)) {
      await this.config.tokenVault.putTokenSet({
        tokenId,
        tenantId,
        userId,
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
      tenantId,
      userId,
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
      throw new OAuthFlowError("OAUTH_PROVIDER_UNSUPPORTED", `Unknown OAuth provider: ${providerId}`, {
        status: 400,
        retryable: false
      });
    }

    return provider;
  }

  private getRuntimeConfig(providerId: string): OAuthProviderRuntimeConfig {
    const runtime = this.config.providerRuntimeConfig[providerId];
    if (!runtime) {
      throw new OAuthFlowError("OAUTH_RUNTIME_CONFIG_INVALID", `Missing runtime OAuth config for provider: ${providerId}`, {
        status: 500,
        retryable: false
      });
    }

    return runtime;
  }

  private resolveRequestId(requestId: string | undefined, metadata: Record<string, unknown> | undefined): string {
    if (requestId) {
      return requestId;
    }
    const metadataRequestId = metadata?.requestId;
    return typeof metadataRequestId === "string" && metadataRequestId.length > 0 ? metadataRequestId : randomUUID();
  }

  private emitEvent(event: OAuthFlowEvent): void {
    this.config.emitEvent?.({
      ...event,
      details: sanitizeDetails(event.details)
    });
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

function normalizeStartSubject(input: OAuthFlowStartInput): OAuthFlowSubject {
  if ("subject" in input) {
    return toFlowSubject(input.subject);
  }

  return {
    kind: "connection",
    tenantId: input.tenantId,
    userId: input.userId,
    connectionId: input.connectionId
  };
}

function toIntentSubject(subject: OAuthFlowSubject): OAuthIntentSubject {
  if (subject.kind === "connection") {
    return {
      kind: "connection",
      tenantId: subject.tenantId ?? "",
      userId: subject.userId ?? "",
      connectionId: subject.connectionId
    };
  }

  return {
    kind: "browser-auth",
    intentId: subject.intentId ?? "",
    tenantId: subject.tenantId,
    regionId: subject.regionId,
    returnTo: subject.returnTo,
    metadata: subject.metadata ? { ...subject.metadata } : undefined
  };
}

function toFlowSubject(subject: OAuthIntentSubject | OAuthStoredStateRecord): OAuthFlowSubject {
  if ("providerId" in subject) {
    const stored = subject.subject;
    if (stored?.kind === "browser-auth" || subject.intentId) {
      return {
        kind: "browser-auth",
        intentId: stored?.kind === "browser-auth" ? stored.intentId : subject.intentId,
        tenantId: stored?.kind === "browser-auth" ? stored.tenantId : subject.tenantId,
        regionId: stored?.kind === "browser-auth" ? stored.regionId : subject.regionId,
        returnTo: stored?.kind === "browser-auth" ? stored.returnTo : subject.returnTo,
        metadata: stored?.kind === "browser-auth" ? stored.metadata : subject.metadata
      };
    }

    return {
      kind: "connection",
      tenantId: stored?.kind === "connection" ? stored.tenantId : subject.tenantId,
      userId: stored?.kind === "connection" ? stored.userId : subject.userId,
      connectionId: stored?.kind === "connection" ? stored.connectionId : subject.connectionId
    };
  }

  if (subject.kind === "connection") {
    return {
      kind: "connection",
      tenantId: subject.tenantId,
      userId: subject.userId,
      connectionId: subject.connectionId
    };
  }

  return {
    kind: "browser-auth",
    intentId: subject.intentId,
    tenantId: subject.tenantId,
    regionId: subject.regionId,
    returnTo: subject.returnTo,
    metadata: subject.metadata ? { ...subject.metadata } : undefined
  };
}

function applyResolvedIdentity(state: OAuthStateRecord, identity: OAuthFlowResolvedIdentity): OAuthStateRecord {
  return {
    ...state,
    tenantId: identity.tenantId,
    userId: identity.userId,
    connectionId: identity.connectionId,
    subject: {
      kind: "connection",
      tenantId: identity.tenantId,
      userId: identity.userId,
      connectionId: identity.connectionId
    }
  } as OAuthStateRecord;
}

function cloneResolvedIdentity(identity: OAuthFlowResolvedIdentity): OAuthFlowResolvedIdentity {
  return {
    ...identity,
    metadata: identity.metadata ? { ...identity.metadata } : undefined
  };
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
    return new OAuthFlowError(error.code as OAuthFlowErrorCode, error.message, {
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
    const sanitizedValue = sanitizeValue(value);
    if (sanitizedValue !== undefined) {
      copy[key] = sanitizedValue;
    }
  }
  return Object.keys(copy).length > 0 ? copy : undefined;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower.includes("token") || lower.includes("secret") || lower.includes("authorization") || lower.includes("bearer")) {
      return undefined;
    }
    return value;
  }

  if (Array.isArray(value)) {
    const sanitizedItems = value
      .map((entry) => sanitizeValue(entry))
      .filter((entry) => entry !== undefined);
    return sanitizedItems.length > 0 ? sanitizedItems : undefined;
  }

  if (value && typeof value === "object") {
    return sanitizeDetails(value as Record<string, unknown>);
  }

  return value;
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
