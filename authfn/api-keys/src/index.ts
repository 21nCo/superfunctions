import type { Route } from '@superfunctions/http';
import type {
  ApiKeyPluginConfig,
  ApiKeyPluginRuntimeConfig
} from 'authfn/plugin-types';
import {
  AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH,
  type AuthFnPlugin,
  type AuthFnPluginRuntimeContext,
  type AuthFnSchemaDefinition
} from 'authfn';
import { createApiKey, listApiKeysForUser, revokeApiKeyById } from 'authfn/core/api-keys';
import { assertValidCsrf, requireCookieSession } from 'authfn/core/sessions';
import { createAuthFnRouteMeta } from 'authfn/http/router';
import { jsonSuccess } from 'authfn/http/envelopes';
import { emitAuthEvent, eventRequestId } from 'authfn/core/observability';
import {
  AuthFnConfigError,
  AuthFnReauthenticationRequiredError,
  AuthFnValidationError
} from 'authfn/core/errors';
import type { AuthFnSessionRecord } from 'authfn';
import { readPluginRuntimeConfig } from 'authfn/core/plugin-runtime';

export type {
  ApiKeyPluginConfig,
  ApiKeyPluginRuntimeConfig
} from 'authfn/plugin-types';

export function authFnApiKeyPlugin(
  config: ApiKeyPluginConfig = {}
): AuthFnPlugin<'apiKey', ApiKeyPluginRuntimeConfig, false> {
  assertPositiveSeconds(config.recentAuthenticationSeconds, 'recentAuthenticationSeconds');
  assertPositiveSeconds(config.defaultExpiresInSeconds, 'defaultExpiresInSeconds');
  assertPositiveSeconds(config.maxExpiresInSeconds, 'maxExpiresInSeconds');
  if (
    config.defaultExpiresInSeconds !== undefined
    && config.maxExpiresInSeconds !== undefined
    && config.defaultExpiresInSeconds > config.maxExpiresInSeconds
  ) {
    throw new AuthFnConfigError('apiKey defaultExpiresInSeconds must not exceed maxExpiresInSeconds', {
      option: 'defaultExpiresInSeconds'
    });
  }
  return {
    name: 'apiKey',
    schema: () => config.schema ?? createApiKeySchema(),
    routes: (ctx) => createApiKeyRoutes(ctx, config)
  };
}

function createApiKeySchema(): AuthFnSchemaDefinition['schemas'] {
  return [
    {
      modelName: 'api_keys',
      fields: {
        id: { type: 'string', required: true, fieldName: 'id', maxLength: 255 },
        userId: {
          type: 'string',
          required: false,
          fieldName: 'user_id',
          maxLength: AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
        },
        name: { type: 'string', required: false, fieldName: 'name' },
        secretHash: { type: 'string', required: true, fieldName: 'secret_hash', maxLength: 255 },
        scopes: { type: 'json', required: false, fieldName: 'scopes' },
        metadata: { type: 'json', required: false, fieldName: 'metadata' },
        expiresAt: { type: 'date', required: false, fieldName: 'expires_at' },
        revokedAt: { type: 'date', required: false, fieldName: 'revoked_at' },
        lastUsedAt: { type: 'date', required: false, fieldName: 'last_used_at' },
        createdAt: { type: 'date', required: true, fieldName: 'created_at' },
        updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
      },
      indexes: [
        {
          name: 'idx_authfn_api_keys_secret_hash',
          fields: ['secretHash'],
          unique: true
        },
        {
          name: 'idx_authfn_api_keys_user_id_created_at',
          fields: ['userId', 'createdAt']
        }
      ]
    }
  ];
}

function createApiKeyRoutes(
  ctx: AuthFnPluginRuntimeContext,
  config: ApiKeyPluginConfig
): Route[] {
  const runtimeConfig = readPluginRuntimeConfig<ApiKeyPluginRuntimeConfig>(ctx, 'apiKey');

  return [
    {
      method: 'POST',
      path: '/api-keys',
      meta: createAuthFnRouteMeta('createApiKey', 'Create a new API key for the current user', {
        mode: 'cookie-session',
        csrf: true
      }),
      handler: async (request) => {
        const state = await requireCookieSession(ctx.config, request);
        assertValidCsrf(request, state);
        const now = runtimeConfig.now?.() ?? new Date();
        assertRecentAuthentication(state.sessionRecord, config, now);
        const body = await request.json() as {
          name?: string;
          scopes?: unknown;
          metadata?: Record<string, unknown>;
          expiresAt?: string;
        };
        const expiresAt = resolveApiKeyExpiry(body.expiresAt, config, now);
        const created = await createApiKey(ctx.config, {
          userId: state.user.id,
          name: body.name ?? 'api-key',
          // createApiKey rejects scopes outside ctx.config.scopes, and any
          // value other than an array of strings (including null), with HTTP
          // 400 before anything is stored. Only an omitted field means none.
          scopes: body.scopes as string[] | undefined,
          metadata: body.metadata,
          expiresAt
        }, {
          now: runtimeConfig.now,
          secretPrefix: config.secretPrefix
        });

        await emitAuthEvent(ctx.config, {
          type: 'authfn.api_key.created',
          requestId: eventRequestId(request),
          actorId: state.user.id,
          userId: state.user.id,
          outcome: 'created',
          metadata: {
            keyId: created.keyId,
            scopes: created.record.scopes ?? []
          }
        });

        return jsonSuccess(request, {
          keyId: created.keyId,
          secret: created.secret,
          secretReturnedOnce: true
        }, {
          status: 201
        });
      }
    },
    {
      method: 'GET',
      path: '/api-keys',
      meta: createAuthFnRouteMeta('listApiKeys', 'List API keys for the current user', {
        mode: 'cookie-session'
      }),
      handler: async (request) => {
        const state = await requireCookieSession(ctx.config, request);
        const keys = await listApiKeysForUser(ctx.config, state.user.id);
        return jsonSuccess(request, {
          keys
        });
      }
    },
    {
      method: 'DELETE',
      path: '/api-keys/:keyId',
      meta: createAuthFnRouteMeta('revokeApiKey', 'Revoke an API key for the current user', {
        mode: 'cookie-session',
        csrf: true
      }),
      handler: async (request, context) => {
        const state = await requireCookieSession(ctx.config, request);
        assertValidCsrf(request, state);
        await revokeApiKeyById(ctx.config, context.params.keyId, {
          userId: state.user.id,
          now: runtimeConfig.now
        });
        await emitAuthEvent(ctx.config, {
          type: 'authfn.api_key.revoked',
          requestId: eventRequestId(request),
          actorId: state.user.id,
          userId: state.user.id,
          outcome: 'revoked',
          metadata: {
            keyId: context.params.keyId
          }
        });
        return jsonSuccess(request, {
          revoked: true,
          keyId: context.params.keyId
        });
      }
    }
  ];
}

/**
 * Refuses key creation from a session that was not signed in recently. The
 * session's creation time is its sign-in time; a session issued by a handoff
 * from another session is never treated as a fresh sign-in.
 */
function assertRecentAuthentication(
  session: AuthFnSessionRecord,
  config: ApiKeyPluginConfig,
  now: Date
): void {
  const windowSeconds = config.recentAuthenticationSeconds;
  if (windowSeconds === undefined) {
    return;
  }
  const isHandoffSession = typeof session.metadata?.sourceSessionId === 'string';
  const signedInAt = new Date(session.createdAt).getTime();
  if (
    isHandoffSession
    || !Number.isFinite(signedInAt)
    || now.getTime() - signedInAt > windowSeconds * 1000
  ) {
    throw new AuthFnReauthenticationRequiredError('Sign in again to create an API key', {
      recentAuthenticationSeconds: windowSeconds
    });
  }
}

/** Applies the configured default and maximum lifetime to a requested key expiry. */
function resolveApiKeyExpiry(
  requested: string | undefined,
  config: ApiKeyPluginConfig,
  now: Date
): Date | undefined {
  const expiresAt = requested
    ? new Date(requested)
    : config.defaultExpiresInSeconds !== undefined
      ? new Date(now.getTime() + config.defaultExpiresInSeconds * 1000)
      : undefined;
  if (config.maxExpiresInSeconds !== undefined) {
    const latest = now.getTime() + config.maxExpiresInSeconds * 1000;
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() > latest) {
      throw new AuthFnValidationError('API key expiry exceeds the allowed lifetime', {
        field: 'expiresAt',
        maxExpiresInSeconds: config.maxExpiresInSeconds
      });
    }
  }
  return expiresAt;
}

function assertPositiveSeconds(value: number | undefined, option: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new AuthFnConfigError(`apiKey ${option} must be a positive whole number of seconds`, {
      option,
      value: String(value)
    });
  }
}
