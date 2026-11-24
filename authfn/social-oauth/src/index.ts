import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Adapter, TableSchema } from '@superfunctions/db';
import type { Route } from '@superfunctions/http';
import {
  createOAuthFlowService, type OAuthFlowCallbackResult, type OAuthFlowResolvedIdentity, type OAuthFlowSubject, type OAuthFlowService, type OAuthProviderRuntimeConfig
} from '@superfunctions/oauth-flow';
import {
  assertCallbackStateMatches, consumeStateOrThrow, generateNonce, generateStateId
} from '@superfunctions/oauth-core';
import { DefaultOAuthTokenHttpClient, type OAuthFetchLike } from '@superfunctions/oauth-http';
import {
  DbAdapterOAuthStateStore, DbAdapterTokenVault, getOAuthStorageTableDefinitions
} from '@superfunctions/oauth-storage';
import {
  createDefaultProviderPolicyRegistry, getOAuthProviderDescriptor
} from '@superfunctions/oauth-providers';
import type {
  SocialOAuthPluginConfig,
  AuthFnSocialOAuthEnvironment,
  AuthFnSocialHandoffMode,
  SocialOAuthPluginRuntimeConfig,
  AuthFnSocialProviderConfig,
  AuthFnSocialProfileResolver,
  AuthFnSocialProfile,
  AuthFnSocialProviderId
} from './types.js';
import {
  AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH,
  AuthFnConfigError,
  type AuthFnRuntimeConfig,
  type AuthFnHookContext,
  type AuthFnHooks,
  type AuthFnPlugin,
  type AuthFnPluginRuntimeContext,
  type AuthFnSchemaDefinition,
  type AuthFnUserRecord
} from 'authfn';
import { assertValidCsrf, issueSession, requireCookieSession } from 'authfn/core/sessions';
import { issueSessionCookies, resolveCookiePolicy } from 'authfn/core/cookies';
import { serializeSetCookie } from '@superfunctions/http';
import { resolveEnvironment } from 'authfn/core/environment';
import {
  beginTwoFactorChallenge,
  createPendingTwoFactorResponse,
  getTwoFactorPluginConfig
} from 'authfn/core/two-factor';
import {
  buildOAuthAccountProfile,
  deleteOAuthAccountByConnectionId,
  findOAuthAccountByProviderAccountId,
  requireOAuthAccountForUser,
  upsertOAuthAccount,
  type AuthFnOAuthAccountRecord
} from 'authfn/core/oauth-accounts';
import {
  AuthFnConflictError,
  AuthFnError,
  AuthFnErrorWithCookies,
  AuthFnOAuthCallbackInvalidError,
  AuthFnOAuthStateInvalidError,
  AuthFnOAuthStateReplayedError,
  AuthFnRegionMismatchError,
  AuthFnOAuthProviderUnsupportedError,
  AuthFnPluginAbortedError,
  AuthFnRedirectUriDisallowedError,
  AuthFnValidationError,
  toAuthFnError
} from 'authfn/core/errors';
import { createUser, findUserById, findUserByPrimaryEmail } from 'authfn/core/users';
import { assertAuthFnDatabaseKeyLength } from 'authfn/core/limits';
import { createAuthFnRouteMeta } from 'authfn/http/router';
import { jsonSuccess, resolveRequestId } from 'authfn/http/envelopes';
import { emitAuthEvent } from 'authfn/core/observability';
import { createOAuthTokenDiagnosticFetcher } from './oauth-support.js';
import {
  allowsOAuthLinkByVerifiedEmail,
  emitAccountLinkedEvent,
  emitAccountLinkingConflictEvent
} from 'authfn/core/account-linking';
import {
  getMultiRegionPluginConfig,
  unregisterRegionLookupForIdentifier
} from 'authfn/core/regions';
import { readPluginRuntimeConfig } from 'authfn/core/plugin-runtime';

type ResolvedSocialOAuthPluginConfig = SocialOAuthPluginConfig & SocialOAuthPluginRuntimeConfig;
export type * from './types.js';
export {
  createAppleClientSecretResolver,
  createOAuthTokenDiagnosticFetcher,
  type AppleClientSecretResolverInput,
  type OAuthTokenDiagnosticFetcherInput
} from './oauth-support.js';

const SOCIAL_PROVIDER_METHODS = {
  google: 'oauth-google',
  apple: 'oauth-apple',
  github: 'oauth-github'
} as const;

const CALLBACK_METADATA_MODE = 'callbackMode';
const CALLBACK_METADATA_HANDOFF = 'handoffMode';
const CALLBACK_METADATA_BINDING = 'browserBindingHash';
const CALLBACK_METADATA_HANDOFF_CHALLENGE = 'handoffChallenge';
const SOCIAL_HANDOFF_STATE_PREFIX = 'social-handoff:';
const SOCIAL_HANDOFF_KIND = 'social-handoff';
const DEFAULT_SOCIAL_HANDOFF_CODE_TTL_SECONDS = 60;
const HANDOFF_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

interface SocialStartBody {
  provider?: AuthFnSocialProviderId;
  returnTo?: string;
  callbackMode?: 'redirect' | 'json';
  handoffMode?: AuthFnSocialHandoffMode;
  handoffChallenge?: string;
}

interface SocialHandoffExchangeBody {
  code?: string;
  verifier?: string;
}

interface NativeAppleStartBody {
  returnTo?: string;
  handoffMode?: AuthFnSocialHandoffMode;
}

interface NativeAppleCompleteBody {
  stateId?: string;
  identityToken?: string;
  authorizationCode?: string;
  user?: {
    /** Accepted for compatibility and ignored: the email comes from the verified identity token. */
    email?: string;
    name?: {
      firstName?: string;
      lastName?: string;
    };
  };
  device?: Record<string, unknown>;
}

interface SocialCallbackCompletion {
  provider: AuthFnSocialProviderId;
  linked: boolean;
  callbackMode: 'redirect' | 'json';
  handoffMode: AuthFnSocialHandoffMode;
  redirectTo?: string;
  session?: Awaited<ReturnType<typeof issueSession>>['session'];
  userId: string;
  oauthAccountId?: string;
  connectionId?: string;
}

interface ResolvedSocialIdentity {
  user: AuthFnUserRecord;
  profile: AuthFnSocialProfile;
  connectionId: string;
  existingAccountId?: string;
  existingAccount?: AuthFnOAuthAccountRecord;
  linkedExistingUser?: boolean;
}

interface ResolvedProviderSettings {
  providerId: AuthFnSocialProviderId;
  clientId: string;
  nativeClientIds: string[];
  clientSecret?: string;
  clientSecretResolver?: AuthFnSocialProviderConfig['clientSecretResolver'];
  allowlistedRedirectUris: string[];
  allowlistedReturnTo: string[];
  scopes: string[];
  linkByVerifiedEmail: boolean;
  requireExistingEmailVerifiedForLink: boolean;
  requireProviderEmailVerifiedForLink: boolean;
  profileResolver?: AuthFnSocialProfileResolver;
}

const MAX_SOCIAL_HANDOFF_CODE_TTL_SECONDS = 3600;

export function authFnSocialOAuthPlugin(
  config: SocialOAuthPluginConfig = {}
): AuthFnPlugin<'socialOAuth', SocialOAuthPluginRuntimeConfig, true> {
  const options: SocialOAuthPluginConfig = {
    schema: config.schema,
    defaultHandoffMode: config.defaultHandoffMode,
    bindBrowserState: config.bindBrowserState,
    allowWebSessionTokenHandoff: config.allowWebSessionTokenHandoff,
    requireHandoffChallenge: config.requireHandoffChallenge,
    handoffCodeTtlSeconds: config.handoffCodeTtlSeconds
  };
  const ttl = options.handoffCodeTtlSeconds;
  if (
    ttl !== undefined &&
    (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_SOCIAL_HANDOFF_CODE_TTL_SECONDS)
  ) {
    throw new AuthFnConfigError(`socialOAuth handoffCodeTtlSeconds must be a positive whole number of seconds, at most ${MAX_SOCIAL_HANDOFF_CODE_TTL_SECONDS}`, {
      option: 'handoffCodeTtlSeconds',
      value: String(ttl)
    });
  }
  return {
    name: 'socialOAuth',
    schema: () => createSocialSchema(options),
    routes: (ctx) => createSocialRoutes(ctx, options)
  };
}

function createSocialSchema(config: SocialOAuthPluginConfig): AuthFnSchemaDefinition['schemas'] {
  return [
    ...createOAuthSharedSchemas(),
    ...(config.schema ?? [createOAuthAccountsSchema()])
  ];
}

function createSocialRoutes(
  ctx: AuthFnPluginRuntimeContext,
  schemaConfig: SocialOAuthPluginConfig
): Route[] {
  const runtimeConfig = readPluginRuntimeConfig<SocialOAuthPluginRuntimeConfig>(ctx, 'socialOAuth');
  const config: ResolvedSocialOAuthPluginConfig = {
    defaultHandoffMode: schemaConfig.defaultHandoffMode,
    bindBrowserState: schemaConfig.bindBrowserState,
    allowWebSessionTokenHandoff: schemaConfig.allowWebSessionTokenHandoff,
    requireHandoffChallenge: schemaConfig.requireHandoffChallenge,
    handoffCodeTtlSeconds: schemaConfig.handoffCodeTtlSeconds,
    providers: runtimeConfig?.providers ?? {},
    fetcher: runtimeConfig?.fetcher,
    tokenHttpClient: runtimeConfig?.tokenHttpClient,
    diagnostics: runtimeConfig?.diagnostics,
    now: runtimeConfig?.now
  };
  const routes: Route[] = [
    {
      method: 'POST',
      path: '/social/start',
      meta: createAuthFnRouteMeta('startSocialSignIn', 'Start social OAuth sign-in', {
        mode: 'none'
      }),
      handler: async (request) => {
        const runtime = await resolveEnvironment(ctx.config, request);
        const body = await request.json() as SocialStartBody;
        // The body is caller JSON. A non-string returnTo would otherwise pick
        // JSON mode by inference (`false`, `0`) or skip the allowlist check
        // when JSON mode is asked for, and still be stored with the flow.
        if (body.returnTo !== undefined && body.returnTo !== null && typeof body.returnTo !== 'string') {
          throw new AuthFnValidationError('returnTo must be a string', {
            returnToType: Array.isArray(body.returnTo) ? 'array' : typeof body.returnTo
          });
        }
        const providerId = normalizeProviderId(body.provider);
        const callbackUri = buildCallbackUri(runtime.baseUrl, ctx.basePath, providerId);
        const providerSettings = resolveProviderSettings(ctx.config, config, runtime, providerId, callbackUri);
        const hookInput = await runBeforeOAuthStart(ctx, request, runtime, {
          provider: providerId,
          returnTo: body.returnTo,
          callbackMode: body.callbackMode ?? inferCallbackMode(body.returnTo),
          handoffMode: body.handoffMode
            ?? inferHandoffMode(
              body.returnTo,
              body.callbackMode ?? inferCallbackMode(body.returnTo),
              config.defaultHandoffMode
            )
        });
        const callbackMode = normalizeCallbackMode(
          readOptionalString(hookInput.callbackMode) ?? body.callbackMode ?? inferCallbackMode(body.returnTo)
        );
        const returnTo = readOptionalString(hookInput.returnTo) ?? body.returnTo;
        const handoffMode = normalizeHandoffMode(
          readOptionalString(hookInput.handoffMode)
            ?? body.handoffMode
            ?? inferHandoffMode(returnTo, callbackMode, config.defaultHandoffMode)
        );

        assertAllowedReturnTarget(providerSettings, returnTo, callbackMode);
        const handoffChallenge = readHandoffChallenge(body.handoffChallenge);
        assertAllowedHandoff(config, {
          returnTo,
          callbackMode,
          handoffMode,
          handoffChallenge
        });
        const usesHandoffCode = handoffMode === 'session-token'
          && callbackMode === 'redirect'
          && Boolean(handoffChallenge);
        const browserBinding = config.bindBrowserState && !usesHandoffCode
          ? createBrowserBindingNonce()
          : undefined;

        const requestId = resolveRequestId(request);
        const flowService = createSocialFlowService(ctx.config, ctx.hooks, config, request, runtime, providerId);
        const result = await flowService.start({
          providerId,
          redirectUri: callbackUri,
          scopes: await authorizeScopes(providerSettings, requestId),
          subject: {
            kind: 'browser-auth',
            intentId: createIdentifier('intent'),
            regionId: runtime.regionId,
            returnTo,
            metadata: {
              [CALLBACK_METADATA_MODE]: callbackMode,
              [CALLBACK_METADATA_HANDOFF]: handoffMode,
              ...(browserBinding ? { [CALLBACK_METADATA_BINDING]: hashBindingValue(browserBinding) } : {}),
              ...(handoffChallenge && handoffMode === 'session-token'
                ? { [CALLBACK_METADATA_HANDOFF_CHALLENGE]: handoffChallenge }
                : {})
            }
          },
          requestId
        });

        await emitAuthEvent(ctx.config, {
          type: 'authfn.oauth.started',
          requestId,
          provider: providerId,
          regionId: runtime.regionId,
          outcome: 'started',
          metadata: {
            stateId: result.stateId,
            callbackMode,
            handoffMode,
            returnTo
          }
        });

        return jsonSuccess(request, {
          provider: providerId,
          redirectTo: result.authorizationUrl,
          stateId: result.stateId,
          expiresAt: result.expiresAt
        }, browserBinding
          ? {
              setCookies: [
                serializeBrowserBindingCookie(ctx, request, runtime, result.stateId, browserBinding, result.expiresAt)
              ]
            }
          : undefined);
      }
    },
    {
      method: 'POST',
      path: '/social/handoff/exchange',
      meta: createAuthFnRouteMeta('exchangeSocialHandoff', 'Exchange a one-time social sign-in handoff code and its verifier for a bearer session', {
        mode: 'none'
      }),
      handler: async (request) => {
        const runtime = await resolveEnvironment(ctx.config, request);
        const body = await request.json().catch(() => ({})) as SocialHandoffExchangeBody;
        const code = readRequiredString(body.code, 'code');
        const verifier = readRequiredString(body.verifier, 'verifier');
        const stateStore = new DbAdapterOAuthStateStore(
          withNamespace(ctx.config.database, ctx.config.namespace ?? 'authfn')
        );
        const stateId = socialHandoffStateId(code);
        const pending = await stateStore.get(stateId);
        const metadata = pending?.subject?.kind === 'browser-auth' ? pending.subject.metadata : undefined;
        if (!pending || metadata?.kind !== SOCIAL_HANDOFF_KIND) {
          throw new AuthFnOAuthStateInvalidError('Social handoff code is invalid');
        }
        if (!verifierMatchesChallenge(verifier, readOptionalString(metadata.challenge))) {
          throw new AuthFnOAuthStateInvalidError('Social handoff verifier does not match');
        }
        if (runtime.regionId && pending.regionId && pending.regionId !== runtime.regionId) {
          throw new AuthFnRegionMismatchError('Social handoff code belongs to a different region', {
            regionId: pending.regionId
          });
        }
        if (Date.parse(pending.expiresAt) <= (config.now?.() ?? new Date()).getTime() || pending.consumedAt) {
          throw new AuthFnOAuthStateReplayedError('Social handoff code was already used or has expired');
        }
        const userId = readRequiredString(metadata.userId, 'userId');
        const user = await findUserById(ctx.config, userId);
        if (!user) {
          throw new AuthFnOAuthCallbackInvalidError('Social handoff user no longer exists', { userId });
        }
        // Same check as core's isAuthFnUserDisabled, which published authfn 0.8.0
        // does not export yet. AUTH-34: use core's helper once authfn 0.9.0
        // ships with the plugins re-released on it.
        if (user.metadata?.disabled === true) {
          throw new AuthFnOAuthCallbackInvalidError('Social handoff user is disabled', { userId });
        }
        // The code was minted by a social sign-in through a linked provider
        // account. If that link is gone (for example, the account was claimed
        // by the owner of its mailbox since), the code no longer stands, even
        // if the same provider has been linked again: the exact link row it
        // was minted for must still exist.
        // A code without that link id (minted before AUTH-32) is refused; it
        // lives for minutes, and the user signs in again.
        const mintedFor = readOptionalString(metadata.oauthAccountId);
        const link = mintedFor
          ? await ctx.config.database.findOne({
              model: 'oauth_accounts',
              where: [
                { field: 'id', operator: 'eq', value: mintedFor },
                { field: 'userId', operator: 'eq', value: user.id }
              ],
              namespace: ctx.config.namespace ?? 'authfn'
            })
          : null;
        if (!link) {
          throw new AuthFnOAuthCallbackInvalidError('Social handoff account link no longer exists', { userId });
        }
        const methods = Array.isArray(metadata.methods)
          ? metadata.methods.filter((method): method is string => typeof method === 'string')
          : [];
        const now = config.now?.() ?? new Date();
        const consumed = await stateStore.consume(stateId, now.toISOString());
        if (!consumed) {
          throw new AuthFnOAuthStateReplayedError('Social handoff code was already used or has expired');
        }
        // The code is single use: if issuance is refused (for example by a
        // placement hook), the client starts the sign-in again.
        const issued = await issueSession(ctx.config, ctx.hooks, {
          request,
          userId: user.id,
          primaryEmail: user.primaryEmail,
          regionId: pending.regionId ?? runtime.regionId,
          methods: methods as Parameters<typeof issueSession>[2]['methods']
        });

        await emitAuthEvent(ctx.config, {
          type: 'authfn.handoff.exchanged',
          requestId: resolveRequestId(request),
          actorId: user.id,
          userId: user.id,
          sessionId: issued.session.id,
          regionId: issued.session.regionId,
          outcome: 'social-exchanged'
        });

        return jsonSuccess(request, {
          session: issued.session,
          handoff: buildSessionHandoffPayload(issued)
        });
      }
    },
    {
      method: 'GET',
      path: '/social/callback/:provider',
      meta: createAuthFnRouteMeta('completeSocialSignIn', 'Complete social OAuth sign-in', {
        mode: 'none'
      }),
      handler: async (request, context) => {
        const providerId = normalizeProviderId(context.params.provider);
        const runtime = await resolveEnvironment(ctx.config, request);
        const callbackUri = buildCallbackUri(runtime.baseUrl, ctx.basePath, providerId);
        const providerSettings = resolveProviderSettings(ctx.config, config, runtime, providerId, callbackUri);
        const url = new URL(request.url);
        const requestId = resolveRequestId(request);
        const flowService = createSocialFlowService(ctx.config, ctx.hooks, config, request, runtime, providerId);
        const stateId = readRequiredString(url.searchParams.get('state'), 'state');
        const errorRedirectTo = await resolveOAuthCallbackErrorRedirectTarget(
          ctx.config,
          providerSettings,
          stateId
        );
        if (stateId.startsWith(SOCIAL_HANDOFF_STATE_PREFIX)) {
          throw new AuthFnOAuthStateInvalidError('OAuth state is invalid');
        }
        try {
        await assertBrowserBinding(ctx, config, request, runtime, stateId);
        const formPostIdToken = readOptionalString(url.searchParams.get('id_token'));
        const callbackResult = providerId === 'apple' && formPostIdToken
          ? await handleAppleFormPostIdentityCallback(
            ctx.config,
            ctx.hooks,
            config,
            request,
            runtime,
            callbackUri,
            stateId,
            formPostIdToken,
            readOptionalString(url.searchParams.get('user')),
            requestId
          )
          : await flowService.handleCallback({
            providerId,
            code: readRequiredString(url.searchParams.get('code'), 'code'),
            state: stateId,
            redirectUri: callbackUri,
            requestId
          });

        const resolvedIdentity = requireResolvedIdentity(callbackResult);
        const user = await findUserById(ctx.config, resolvedIdentity.userId);
        if (!user) {
          throw new AuthFnOAuthCallbackInvalidError('Linked authfn user not found after OAuth callback', {
            provider: providerId,
            userId: resolvedIdentity.userId
          });
        }

        const twoFactorConfig = getTwoFactorPluginConfig(ctx.config);
        if (twoFactorConfig) {
          const pendingChallenge = await beginTwoFactorChallenge(
            ctx.config,
            user,
            SOCIAL_PROVIDER_METHODS[providerId],
            twoFactorConfig
          );
          if (pendingChallenge) {
            const challengeError = createPendingTwoFactorResponse(pendingChallenge.challenge);
            const completion = {
              provider: providerId,
              linked: true,
              callbackMode: readStoredCallbackMode(callbackResult),
              handoffMode: readStoredHandoffMode(callbackResult, config.defaultHandoffMode),
              redirectTo: callbackResult.subject.returnTo,
              challengeId: pendingChallenge.challenge.id,
              primaryMethod: SOCIAL_PROVIDER_METHODS[providerId]
            } as Record<string, unknown>;

            await ctx.hooks.afterOAuthCallback?.(
              buildHookContext(ctx.config, request, runtime, user.id),
              completion
            );
            // As in the other branches: the hook may have changed the target,
            // so it is checked, and the location built, before the flow is
            // reported.
            let challengeLocation: string | undefined;
            if (completion.callbackMode === 'redirect') {
              assertAllowedReturnTarget(providerSettings, completion.redirectTo as string | undefined, 'redirect');
              challengeLocation = appendTwoFactorChallengeToReturnTarget(
                completion.redirectTo as string,
                pendingChallenge.challenge.id,
                SOCIAL_PROVIDER_METHODS[providerId]
              );
            }

            await emitAuthEvent(ctx.config, {
              type: 'authfn.2fa.challenged',
              requestId,
              actorId: user.id,
              userId: user.id,
              regionId: runtime.regionId,
              provider: providerId,
              outcome: 'required',
              metadata: {
                challengeId: pendingChallenge.challenge.id,
                primaryMethod: SOCIAL_PROVIDER_METHODS[providerId]
              }
            });

            await emitAuthEvent(ctx.config, {
              type: 'authfn.oauth.completed',
              requestId,
              actorId: user.id,
              userId: user.id,
              regionId: runtime.regionId,
              provider: providerId,
              outcome: 'two-factor-required',
              metadata: {
                callbackMode: completion.callbackMode,
                handoffMode: completion.handoffMode,
                challengeId: pendingChallenge.challenge.id
              }
            });

            if (challengeLocation !== undefined) {
              return redirectWithCookies(
                request,
                challengeLocation,
                config.bindBrowserState ? [clearBrowserBindingCookie(ctx, request, runtime, stateId)] : [],
                303
              );
            }

            throw challengeError;
          }
        }

        const oauthAccountId = readOptionalString(resolvedIdentity.metadata?.oauthAccountId);
        if (readOptionalBoolean(resolvedIdentity.metadata?.linkedExistingUser)) {
          await emitAccountLinkedEvent(ctx.config, {
            request,
            user,
            method: SOCIAL_PROVIDER_METHODS[providerId],
            provider: providerId,
            regionId: runtime.regionId,
            metadata: {
              oauthAccountId,
              connectionId: callbackResult.connectionId
            }
          });
        }
        const handoffChallenge = readOptionalString(
          callbackResult.subject.metadata?.[CALLBACK_METADATA_HANDOFF_CHALLENGE]
        );
        assertAllowedHandoff(config, {
          returnTo: callbackResult.subject.returnTo,
          callbackMode: readStoredCallbackMode(callbackResult),
          handoffMode: readStoredHandoffMode(callbackResult, config.defaultHandoffMode),
          handoffChallenge
        });
        if (handoffChallenge && isHandoffCodeFlow(callbackResult.subject.metadata, config.defaultHandoffMode)) {
          const redirectTo = callbackResult.subject.returnTo;
          assertAllowedReturnTarget(providerSettings, redirectTo, 'redirect');
          const handoffCode = await createSocialHandoffCode(ctx, config, {
            providerId,
            redirectUri: callbackUri,
            userId: user.id,
            regionId: runtime.regionId,
            methods: [SOCIAL_PROVIDER_METHODS[providerId]],
            challenge: handoffChallenge,
            oauthAccountId
          });
          const completion = {
            provider: providerId,
            linked: true,
            callbackMode: 'redirect',
            handoffMode: 'session-token',
            redirectTo,
            userId: user.id,
            oauthAccountId,
            connectionId: callbackResult.connectionId,
            handoffCodeIssued: true
          } as Record<string, unknown>;
          await ctx.hooks.afterOAuthCallback?.(
            buildHookContext(ctx.config, request, runtime, user.id),
            completion
          );
          // The hook may have changed the target, so it is checked again with
          // the policies /social/start applied, before the flow is reported
          // complete. A refused code never leaves the server.
          assertAllowedReturnTarget(providerSettings, completion.redirectTo as string | undefined, 'redirect');
          assertAllowedHandoff(config, {
            returnTo: completion.redirectTo as string | undefined,
            callbackMode: 'redirect',
            handoffMode: 'session-token',
            handoffChallenge
          });
          // Built from the values just checked, before anything else is
          // awaited, so later changes to the completion object do not apply.
          const handoffLocation = appendHandoffCodeToReturnTarget(
            completion.redirectTo as string,
            handoffCode,
            runtime.regionId
          );
          await emitAuthEvent(ctx.config, {
            type: 'authfn.oauth.completed',
            requestId,
            actorId: user.id,
            userId: user.id,
            regionId: runtime.regionId,
            provider: providerId,
            outcome: 'handoff-code-issued',
            metadata: {
              callbackMode: 'redirect',
              handoffMode: 'session-token',
              connectionId: callbackResult.connectionId
            }
          });
          return redirectWithCookies(request, handoffLocation, [], 303);
        }

        const issued = await issueSession(ctx.config, ctx.hooks, {
          request,
          userId: user.id,
          primaryEmail: user.primaryEmail,
          regionId: runtime.regionId,
          methods: [SOCIAL_PROVIDER_METHODS[providerId]]
        });
        const cookies = Object.values(
          issueSessionCookies(issued.cookiePolicy!, issued.sessionToken, issued.csrfToken)
        );
        if (config.bindBrowserState) {
          cookies.push(clearBrowserBindingCookie(ctx, request, runtime, stateId));
        }
        const completion: SocialCallbackCompletion = {
          provider: providerId,
          linked: true,
          callbackMode: readStoredCallbackMode(callbackResult),
          handoffMode: readStoredHandoffMode(callbackResult, config.defaultHandoffMode),
          redirectTo: callbackResult.subject.returnTo,
          session: issued.session,
          userId: user.id,
          oauthAccountId,
          connectionId: callbackResult.connectionId
        };

        await ctx.hooks.afterOAuthCallback?.(
          buildHookContext(ctx.config, request, runtime, user.id, issued.session),
          completion as unknown as Record<string, unknown>
        );
        let redirectLocation: string | undefined;
        if (completion.callbackMode === 'redirect') {
          // The hook may have changed the target, so the allowlist and the
          // handoff policy are checked again before the flow is reported
          // complete. A refused session's token and cookies never leave the
          // server. The location is built from the checked values before
          // anything else is awaited.
          assertAllowedReturnTarget(providerSettings, completion.redirectTo, 'redirect');
          assertAllowedHandoff(config, {
            returnTo: completion.redirectTo,
            callbackMode: completion.callbackMode,
            handoffMode: completion.handoffMode,
            handoffChallenge
          });
          redirectLocation = completion.handoffMode === 'session-token'
            ? appendSessionHandoffToReturnTarget(completion.redirectTo!, issued)
            : serializeReturnTarget(completion.redirectTo!);
        }

        await emitAuthEvent(ctx.config, {
          type: 'authfn.oauth.completed',
          requestId,
          actorId: user.id,
          sessionId: issued.session.id,
          userId: user.id,
          regionId: runtime.regionId,
          provider: providerId,
          outcome: 'linked',
          metadata: {
            callbackMode: completion.callbackMode,
            handoffMode: completion.handoffMode,
            oauthAccountId,
            connectionId: callbackResult.connectionId
          }
        });

        if (redirectLocation !== undefined) {
          return redirectWithCookies(request, redirectLocation, cookies, 303);
        }

        return jsonSuccess(request, {
          linked: completion.linked,
          provider: completion.provider,
          session: completion.session,
          ...(completion.handoffMode === 'session-token'
            ? {
                handoff: buildSessionHandoffPayload(issued)
              }
            : {})
        }, {
          setCookies: cookies
        });
        } catch (error) {
          if (errorRedirectTo) {
            const authError = toAuthFnError(error);
            await emitAuthEvent(ctx.config, {
              type: 'authfn.oauth.failed',
              requestId,
              provider: providerId,
              regionId: runtime.regionId,
              outcome: 'redirected-error',
              metadata: {
                authErrorKind: authError.code,
                authErrorMessage: authError.message,
                providerError: readOptionalString(authError.details?.error),
                providerErrorDescription: readOptionalString(authError.details?.error_description),
                returnTo: errorRedirectTo,
                debugError: isDebugErrorLoggingEnabled()
                  ? summarizeOAuthFailureError(error)
                  : undefined
              }
            });
            return redirectWithCookies(
              request,
              appendOAuthErrorToReturnTarget(errorRedirectTo, providerId, requestId, authError),
              config.bindBrowserState ? [clearBrowserBindingCookie(ctx, request, runtime, stateId)] : [],
              303
            );
          }
          if (config.bindBrowserState) {
            throw new AuthFnErrorWithCookies(error, [
              clearBrowserBindingCookie(ctx, request, runtime, stateId)
            ]);
          }
          throw error;
        }
      }
    },
    {
      method: 'POST',
      path: '/social/callback/:provider',
      meta: createAuthFnRouteMeta('completeSocialSignInFormPost', 'Complete social OAuth sign-in via form_post', {
        mode: 'none'
      }),
      handler: async (request, context) => {
        const callbackRoute = routes.find((route) =>
          route.method === 'GET' && route.path === '/social/callback/:provider'
        );
        if (!callbackRoute) {
          throw new AuthFnError('AUTHFN_INTERNAL_ERROR', 'Social OAuth callback handler is not registered', {
            status: 500,
            retryable: true
          });
        }
        return callbackRoute.handler(await createFormPostCallbackRequest(request), context);
      }
    },
    {
      method: 'POST',
      path: '/social/native/apple/start',
      meta: createAuthFnRouteMeta('startNativeAppleSignIn', 'Start native Apple sign-in', {
        mode: 'none'
      }),
      handler: async (request) => {
        const runtime = await resolveEnvironment(ctx.config, request);
        const body = await request.json().catch(() => ({})) as NativeAppleStartBody;
        const providerId = 'apple';
        const callbackUri = buildCallbackUri(runtime.baseUrl, ctx.basePath, providerId);
        const providerSettings = resolveProviderSettings(ctx.config, config, runtime, providerId, callbackUri);
        const returnTo = readOptionalString(body.returnTo);
        const handoffMode = normalizeHandoffMode(readOptionalString(body.handoffMode) ?? 'session-token');
        assertAllowedReturnTarget(providerSettings, returnTo, 'json');

        const requestId = resolveRequestId(request);
        const issuedAt = config.now?.() ?? new Date();
        const createdAt = issuedAt.toISOString();
        const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString();
        const stateId = generateStateId();
        const nonce = generateNonce();
        const stateStore = new DbAdapterOAuthStateStore(
          withNamespace(ctx.config.database, ctx.config.namespace ?? 'authfn')
        );

        await stateStore.put({
          stateId,
          providerId,
          redirectUri: callbackUri,
          requestedScopes: providerSettings.scopes,
          subject: {
            kind: 'browser-auth',
            intentId: createIdentifier('intent'),
            regionId: runtime.regionId,
            returnTo,
            metadata: {
              [CALLBACK_METADATA_MODE]: 'json',
              [CALLBACK_METADATA_HANDOFF]: handoffMode,
              nativeProvider: 'apple'
            }
          },
          nonce,
          createdAt,
          expiresAt
        });

        await emitAuthEvent(ctx.config, {
          type: 'authfn.oauth.started',
          requestId,
          provider: providerId,
          regionId: runtime.regionId,
          outcome: 'started',
          metadata: {
            stateId,
            callbackMode: 'json',
            handoffMode,
            nativeProvider: 'apple'
          }
        });

        return jsonSuccess(request, {
          provider: providerId,
          stateId,
          nonce,
          expiresAt
        });
      }
    },
    {
      method: 'POST',
      path: '/social/native/apple/complete',
      meta: createAuthFnRouteMeta('completeNativeAppleSignIn', 'Complete native Apple sign-in', {
        mode: 'none'
      }),
      handler: async (request) => {
        const runtime = await resolveEnvironment(ctx.config, request);
        const body = await request.json() as NativeAppleCompleteBody;
        const requestId = resolveRequestId(request);
        const stateId = readRequiredString(body.stateId, 'stateId');
        if (stateId.startsWith(SOCIAL_HANDOFF_STATE_PREFIX)) {
          throw new AuthFnOAuthStateInvalidError('OAuth state is invalid');
        }
        const identityToken = readRequiredString(body.identityToken, 'identityToken');
        const callbackUri = buildCallbackUri(runtime.baseUrl, ctx.basePath, 'apple');
        const providerSettings = resolveProviderSettings(ctx.config, config, runtime, 'apple', callbackUri);
        const stateStore = new DbAdapterOAuthStateStore(
          withNamespace(ctx.config.database, ctx.config.namespace ?? 'authfn')
        );
        const consumedState = await consumeStateOrThrow(
          stateStore,
          stateId,
          (config.now?.() ?? new Date()).toISOString()
        );
        assertCallbackStateMatches(
          {
            providerId: 'apple',
            redirectUri: callbackUri
          },
          consumedState
        );

        const profile = await resolveAppleNativeProfile(
          identityToken,
          body.user,
          consumedState.nonce,
          [providerSettings.clientId, ...providerSettings.nativeClientIds]
        );
        const resolved = await resolveLocalIdentityFromProfile(
          ctx.config,
          ctx.hooks,
          request,
          runtime,
          'apple',
          providerSettings,
          profile
        );
        // A token without an email says nothing about the email, so the
        // already linked account found while resolving the identity is used
        // as stored rather than rewritten: writing it back could erase the
        // email it holds.
        const storedAccount = profile.email === undefined ? resolved.existingAccount : undefined;
        const account = storedAccount ?? await upsertOAuthAccount(ctx.config, {
          userId: resolved.user.id,
          provider: 'apple',
          providerAccountId: profile.providerAccountId,
          connectionId: resolved.connectionId,
          email: profile.email,
          profile: profile.profile
        });
        const user = resolved.user;
        const twoFactorConfig = getTwoFactorPluginConfig(ctx.config);
        if (twoFactorConfig) {
          const pendingChallenge = await beginTwoFactorChallenge(
            ctx.config,
            user,
            SOCIAL_PROVIDER_METHODS.apple,
            twoFactorConfig
          );
          if (pendingChallenge) {
            throw createPendingTwoFactorResponse(pendingChallenge.challenge);
          }
        }

        const issued = await issueSession(ctx.config, ctx.hooks, {
          request,
          userId: user.id,
          primaryEmail: user.primaryEmail,
          regionId: runtime.regionId,
          methods: [SOCIAL_PROVIDER_METHODS.apple]
        });
        const isNewUser = !resolved.existingAccountId && !resolved.linkedExistingUser;

        await ctx.hooks.afterOAuthCallback?.(
          buildHookContext(ctx.config, request, runtime, user.id, issued.session),
          {
            provider: 'apple',
            linked: true,
            callbackMode: 'json',
            handoffMode: 'session-token',
            session: issued.session,
            userId: user.id,
            oauthAccountId: account.id,
            connectionId: resolved.connectionId
          } as unknown as Record<string, unknown>
        );

        await emitAuthEvent(ctx.config, {
          type: 'authfn.oauth.completed',
          requestId,
          actorId: user.id,
          sessionId: issued.session.id,
          userId: user.id,
          regionId: runtime.regionId,
          provider: 'apple',
          outcome: resolved.linkedExistingUser ? 'linked-existing-user' : 'linked',
          metadata: {
            callbackMode: 'json',
            handoffMode: 'session-token',
            oauthAccountId: account.id,
            connectionId: resolved.connectionId,
            nativeProvider: 'apple',
            isNewUser
          }
        });
        if (resolved.linkedExistingUser) {
          await emitAccountLinkedEvent(ctx.config, {
            request,
            user,
            method: SOCIAL_PROVIDER_METHODS.apple,
            provider: 'apple',
            regionId: runtime.regionId,
            metadata: {
              oauthAccountId: account.id,
              connectionId: resolved.connectionId,
              nativeProvider: 'apple',
              isNewUser
            }
          });
        }

        return jsonSuccess(request, {
          provider: 'apple',
          linked: true,
          isNewUser,
          token: issued.sessionToken,
          session: issued.session,
          sessionId: issued.session.id,
          regionId: issued.session.regionId ?? runtime.regionId,
          expiresAt: issued.session.expiresAt?.toISOString() ?? null,
          userId: user.id,
          oauthAccountId: account.id
        });
      }
    },
    {
      method: 'POST',
      path: '/social/disconnect/:provider',
      meta: createAuthFnRouteMeta('disconnectSocialAccount', 'Disconnect a linked social OAuth account', {
        mode: 'cookie-session',
        csrf: true
      }),
      handler: async (request, context) => {
        const providerId = normalizeProviderId(context.params.provider);
        const runtime = await resolveEnvironment(ctx.config, request);
        const state = await requireCookieSession(ctx.config, request);
        assertValidCsrf(request, state);
        const callbackUri = buildCallbackUri(runtime.baseUrl, ctx.basePath, providerId);
        resolveProviderSettings(ctx.config, config, runtime, providerId, callbackUri);
        const account = await requireOAuthAccountForUser(ctx.config, state.user.id, providerId);
        const flowService = createSocialFlowService(ctx.config, ctx.hooks, config, request, runtime, providerId);

        await flowService.disconnect({
          connectionId: account.connectionId,
          providerId,
          revokeRemote: true,
          requestId: resolveRequestId(request)
        });

        return jsonSuccess(request, {
          disconnected: true,
          provider: providerId
        });
      }
    }
  ];
  return routes;
}

function createSocialFlowService(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  pluginConfig: ResolvedSocialOAuthPluginConfig,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  activeProviderId: AuthFnSocialProviderId
): OAuthFlowService {
  const providers = {
    [activeProviderId]: getOAuthProviderDescriptor(activeProviderId)
  };
  const callbackUri = buildCallbackUri(runtime.baseUrl, config.basePath ?? '/auth', activeProviderId);
  const settings = resolveProviderSettings(config, pluginConfig, runtime, activeProviderId, callbackUri);
  const providerRuntimeConfig = {
    [activeProviderId]: {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      clientSecretResolver: settings.clientSecretResolver,
      allowlistedRedirectUris: settings.allowlistedRedirectUris
    } satisfies OAuthProviderRuntimeConfig
  };
  const namespacedAdapter = withNamespace(config.database, config.namespace ?? 'authfn');
  const tokenHttpClient = pluginConfig.tokenHttpClient ?? new DefaultOAuthTokenHttpClient({
    fetcher: resolveTokenExchangeFetcher(config, pluginConfig, request)
  });

  return createOAuthFlowService({
    providers,
    providerRuntimeConfig,
    stateStore: new DbAdapterOAuthStateStore(namespacedAdapter),
    tokenVault: new DbAdapterTokenVault(namespacedAdapter),
    tokenHttpClient,
    now: pluginConfig.now,
    identityHooks: {
      resolveBrowserAuthIdentity: async ({ providerId, tokenSet }) => {
        const resolved = await resolveLocalIdentity(
          config,
          hooks,
          pluginConfig,
          request,
          runtime,
          normalizeProviderId(providerId),
          tokenSet
        );

        const identity: OAuthFlowResolvedIdentity = {
          tenantId: config.namespace ?? 'authfn',
          userId: resolved.user.id,
          connectionId: resolved.connectionId,
          persistTokens: false,
          metadata: {
            oauthAccountId: resolved.existingAccountId,
            linkedExistingUser: resolved.linkedExistingUser,
            profile: buildOAuthAccountProfile(normalizeProviderId(providerId), resolved.profile)
          }
        };

        return identity;
      },
      onConnected: async (result) => {
        const resolvedIdentity = requireResolvedIdentity(result);
        const userId = resolvedIdentity.userId;
        const profile = readProfileMetadata(resolvedIdentity.metadata);
        const account = await upsertOAuthAccount(config, {
          userId,
          provider: normalizeProviderId(result.providerId),
          providerAccountId: profile.providerAccountId,
          connectionId: result.connectionId ?? readRequiredString(resolvedIdentity.connectionId, 'connectionId'),
          email: profile.email,
          profile: profile.profile
        });

        if (resolvedIdentity.metadata) {
          resolvedIdentity.metadata.oauthAccountId = account.id;
        }
      },
      onDisconnected: async (input) => {
        await deleteOAuthAccountByConnectionId(config, input.connectionId);
      }
    }
  });
}

async function handleAppleFormPostIdentityCallback(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  pluginConfig: ResolvedSocialOAuthPluginConfig,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  callbackUri: string,
  stateId: string,
  idToken: string,
  userPayload: string | undefined,
  requestId: string
): Promise<OAuthFlowCallbackResult> {
  const stateStore = new DbAdapterOAuthStateStore(
    withNamespace(config.database, config.namespace ?? 'authfn')
  );
  const consumedState = await consumeStateOrThrow(
    stateStore,
    stateId,
    (pluginConfig.now?.() ?? new Date()).toISOString()
  );
  assertCallbackStateMatches(
    {
      providerId: 'apple',
      redirectUri: callbackUri
    },
    consumedState
  );

  const subject = toOAuthFlowSubject(consumedState);
  const providerSettings = resolveProviderSettings(config, pluginConfig, runtime, 'apple', callbackUri);
  const claims = await verifyAppleIdentityToken(idToken, providerSettings.clientId);
  const profile = resolveAppleFormPostProfile(claims, userPayload, consumedState.nonce);
  const resolved = await resolveLocalIdentityFromProfile(
    config,
    hooks,
    request,
    runtime,
    'apple',
    providerSettings,
    profile
  );
  const account = await upsertOAuthAccount(config, {
    userId: resolved.user.id,
    provider: 'apple',
    providerAccountId: profile.providerAccountId,
    connectionId: resolved.connectionId,
    email: profile.email,
    profile: profile.profile
  });

  return {
    providerId: 'apple',
    subject,
    tokenSet: {
      accessToken: `apple_form_post_${requestId}`,
      idToken,
      tokenType: 'Bearer'
    },
    connectionId: resolved.connectionId,
    resolvedIdentity: {
      tenantId: config.namespace ?? 'authfn',
      userId: resolved.user.id,
      connectionId: resolved.connectionId,
      persistTokens: false,
      metadata: {
        oauthAccountId: account.id,
        linkedExistingUser: resolved.linkedExistingUser,
        profile: buildOAuthAccountProfile('apple', profile)
      }
    }
  };
}

async function resolveLocalIdentity(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  pluginConfig: ResolvedSocialOAuthPluginConfig,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  providerId: AuthFnSocialProviderId,
  tokenSet: SocialTokenSet
): Promise<ResolvedSocialIdentity> {
  const providerSettings = resolveProviderSettings(
    config,
    pluginConfig,
    runtime,
    providerId,
    buildCallbackUri(runtime.baseUrl, config.basePath ?? '/auth', providerId)
  );
  const profile = await resolveProviderProfile(providerId, tokenSet, request, runtime, providerSettings, pluginConfig.fetcher);
  return resolveLocalIdentityFromProfile(
    config,
    hooks,
    request,
    runtime,
    providerId,
    providerSettings,
    profile
  );
}

async function resolveLocalIdentityFromProfile(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  providerId: AuthFnSocialProviderId,
  providerSettings: ResolvedProviderSettings,
  profile: AuthFnSocialProfile
): Promise<ResolvedSocialIdentity> {
  const existingAccount = await findOAuthAccountByProviderAccountId(config, providerId, profile.providerAccountId);
  if (existingAccount) {
    const linkedUser = await findUserById(config, existingAccount.userId);
    if (!linkedUser) {
      throw new AuthFnOAuthCallbackInvalidError('OAuth account links to a missing authfn user', {
        provider: providerId,
        providerAccountId: profile.providerAccountId
      });
    }

    return {
      user: linkedUser,
      profile,
      connectionId: existingAccount.connectionId,
      existingAccountId: existingAccount.id,
      existingAccount
    };
  }
  assertAuthFnDatabaseKeyLength(profile.providerAccountId, 'providerAccountId');

  const normalizedEmail = normalizeEmail(profile.email);
  if (normalizedEmail) {
    const existingUser = await findUserByPrimaryEmail(config, normalizedEmail);
    if (existingUser) {
      const providerEmailAccepted = providerSettings.requireProviderEmailVerifiedForLink
        ? profile.emailVerified === true
        : true;
      const existingEmailAccepted = providerSettings.requireExistingEmailVerifiedForLink
        ? Boolean(existingUser.emailVerifiedAt)
        : true;
      if (providerSettings.linkByVerifiedEmail && providerEmailAccepted && existingEmailAccepted) {
        return {
          user: existingUser,
          profile: {
            ...profile,
            email: normalizedEmail
          },
          connectionId: createConnectionId(providerId, existingUser.id),
          linkedExistingUser: true
        };
      }

      await emitAccountLinkingConflictEvent(config, {
        request,
        user: existingUser,
        provider: providerId,
        regionId: runtime.regionId,
        method: SOCIAL_PROVIDER_METHODS[providerId],
        reason: !providerSettings.linkByVerifiedEmail
          ? 'oauth_verified_email_linking_disabled'
          : !providerEmailAccepted
            ? 'provider_email_unverified'
            : 'existing_email_unverified',
        metadata: {
          providerEmailVerified: profile.emailVerified === true,
          requireProviderEmailVerified: providerSettings.requireProviderEmailVerifiedForLink,
          requireExistingEmailVerified: providerSettings.requireExistingEmailVerifiedForLink
        }
      });
      throw new AuthFnConflictError('A user with this email already exists', {
        provider: providerId,
        primaryEmail: normalizedEmail
      });
    }
  }

  const user = await createSocialUser(config, request, runtime, providerId, {
    ...profile,
    email: normalizedEmail
  }, hooks);
  return {
    user,
    profile: {
      ...profile,
      email: normalizedEmail
    },
    connectionId: createConnectionId(providerId, user.id)
  };
}

async function createSocialUser(
  config: AuthFnRuntimeConfig,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  providerId: AuthFnSocialProviderId,
  profile: AuthFnSocialProfile,
  hooks: Partial<AuthFnHooks>
): Promise<AuthFnUserRecord> {
  const now = new Date();
  const input = {
    primaryEmail: profile.email,
    emailVerifiedAt: profile.emailVerified ? now : null,
    metadata: profile.name
      ? {
          displayName: profile.name,
          socialProvider: providerId
        }
      : {
          socialProvider: providerId
        }
  };
  const transformed = await hooks.beforeUserCreate?.(
    buildHookContext(config, request, runtime),
    input
  ) as typeof input | void;
  const resolved = transformed ?? input;
  const user = await createUser(config, {
    primaryEmail: normalizeEmail(readOptionalString(resolved.primaryEmail)),
    emailVerifiedAt: resolved.emailVerifiedAt instanceof Date ? resolved.emailVerifiedAt : input.emailVerifiedAt,
    metadata: readRecord(resolved.metadata) ?? input.metadata
  });

  try {
    await hooks.afterUserCreate?.(
      buildHookContext(config, request, runtime, user.id),
      {
        id: user.id,
        primaryEmail: user.primaryEmail,
        metadata: user.metadata ?? {}
      }
    );
  } catch (afterHookError) {
    if (afterHookError instanceof AuthFnError) {
      await rollbackSocialUser(config, user.id, user.primaryEmail);
      throw afterHookError;
    }
    // Fail-open by hook contract.
  }

  return user;
}

async function rollbackSocialUser(
  config: Pick<AuthFnRuntimeConfig, 'stores' | 'database' | 'namespace' | 'plugins' | 'pluginRuntime'>,
  userId: string,
  primaryEmail?: string | null
): Promise<void> {
  const multiRegion = getMultiRegionPluginConfig(config);
  if (primaryEmail && multiRegion) {
    await unregisterRegionLookupForIdentifier(config, multiRegion, primaryEmail).catch(() => undefined);
  }

  await config.database.deleteMany({
    model: 'region_profiles',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: config.namespace ?? 'authfn'
  }).catch(() => undefined);

  await config.database.delete({
    model: 'users',
    where: [{ field: 'id', operator: 'eq', value: userId }],
    namespace: config.namespace ?? 'authfn'
  }).catch(() => undefined);
}

function resolveProviderSettings(
  authConfig: Pick<AuthFnRuntimeConfig, 'accountLinking'>,
  pluginConfig: ResolvedSocialOAuthPluginConfig,
  runtime: AuthFnSocialOAuthEnvironment,
  providerId: AuthFnSocialProviderId,
  callbackUri: string
): ResolvedProviderSettings {
  const staticConfig = pluginConfig.providers?.[providerId] ?? {};
  const runtimeConfig = (
    (runtime.oauth ?? {}) as Partial<Record<AuthFnSocialProviderId, AuthFnSocialProviderConfig>>
  )[providerId] ?? {};
  const clientId = readOptionalString(runtimeConfig.clientId) ?? staticConfig.clientId;
  if (!clientId) {
    throw new AuthFnValidationError('Social OAuth runtime config missing clientId', {
      provider: providerId
    });
  }

  const verifiedEmailLinking = allowsOAuthLinkByVerifiedEmail(authConfig, providerId);
  const providerLinkOverride = staticConfig.linkByVerifiedEmail;
  const hasRuntimeNativeClientIds = Object.prototype.hasOwnProperty.call(runtimeConfig, 'nativeClientIds');

  return {
    providerId,
    clientId,
    nativeClientIds: hasRuntimeNativeClientIds
      ? readStringArray(runtimeConfig.nativeClientIds) ?? []
      : readStringArray(staticConfig.nativeClientIds) ?? [],
    clientSecret: readOptionalString(runtimeConfig.clientSecret) ?? staticConfig.clientSecret,
    clientSecretResolver: readResolver(runtimeConfig.clientSecretResolver) ?? staticConfig.clientSecretResolver,
    allowlistedRedirectUris: readStringArray(runtimeConfig.allowlistedRedirectUris)
      ?? readStringArray(staticConfig.allowlistedRedirectUris)
      ?? [callbackUri],
    allowlistedReturnTo: readStringArray(runtimeConfig.allowlistedReturnTo)
      ?? readStringArray(staticConfig.allowlistedReturnTo)
      ?? [],
    scopes: readStringArray(runtimeConfig.scopes)
      ?? readStringArray(staticConfig.scopes)
      ?? getOAuthProviderDescriptor(providerId).defaultScopes,
    linkByVerifiedEmail: providerLinkOverride ?? verifiedEmailLinking.allowed,
    requireExistingEmailVerifiedForLink: verifiedEmailLinking.requireExistingEmailVerified,
    requireProviderEmailVerifiedForLink: verifiedEmailLinking.requireProviderEmailVerified,
    profileResolver: staticConfig.profileResolver
  };
}

function resolveTokenExchangeFetcher(
  config: AuthFnRuntimeConfig,
  pluginConfig: ResolvedSocialOAuthPluginConfig,
  request: Request
): OAuthFetchLike | undefined {
  const tokenExchangeDiagnostics = pluginConfig.diagnostics === false
    ? false
    : pluginConfig.diagnostics?.tokenExchange;
  if (!tokenExchangeDiagnostics) {
    return pluginConfig.fetcher;
  }
  return createOAuthTokenDiagnosticFetcher({
    fetcher: pluginConfig.fetcher,
    observability: config.observability,
    requestId: resolveRequestId(request),
    diagnostics: tokenExchangeDiagnostics
  });
}

async function authorizeScopes(
  settings: ResolvedProviderSettings,
  requestId: string
): Promise<string[]> {
  const registry = createDefaultProviderPolicyRegistry(() => new Date().toISOString());
  registry.assertOperationAllowed({
    providerId: settings.providerId,
    operation: 'auth.signin',
    featureMode: 'metadata-only'
  });
  await registry.validateScopes({
    providerId: settings.providerId,
    feature: 'auth.social.profile',
    requestedScopes: settings.scopes,
    tenantId: 'authfn',
    userId: requestId,
    purpose: 'auth.signin'
  });

  return [...settings.scopes];
}

async function resolveProviderProfile(
  providerId: AuthFnSocialProviderId,
  tokenSet: SocialTokenSet,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  settings: ResolvedProviderSettings,
  fetcher: OAuthFetchLike | undefined
): Promise<AuthFnSocialProfile> {
  if (settings.profileResolver) {
    return settings.profileResolver({
      providerId,
      tokenSet,
      request,
      environment: runtime,
      fetcher
    });
  }

  switch (providerId) {
    case 'google':
      return resolveGoogleProfile(tokenSet);
    case 'apple':
      return resolveAppleProfile(tokenSet);
    case 'github':
      return resolveGitHubProfile(tokenSet, fetcher);
    default:
      throw new AuthFnOAuthProviderUnsupportedError('Unsupported social OAuth provider', {
        provider: providerId
      });
  }
}

function resolveGoogleProfile(tokenSet: SocialTokenSet): AuthFnSocialProfile {
  const claims = parseIdTokenClaims(tokenSet.idToken);
  if (!claims.sub) {
    throw new AuthFnOAuthCallbackInvalidError('Google OAuth callback missing required subject claim', {
      provider: 'google'
    });
  }

  return {
    providerAccountId: claims.sub,
    email: normalizeEmail(claims.email),
    emailVerified: claims.emailVerified,
    name: claims.name,
    profile: cleanObject({
      sub: claims.sub,
      email: normalizeEmail(claims.email),
      emailVerified: claims.emailVerified,
      name: claims.name
    })
  };
}

function resolveAppleProfile(tokenSet: SocialTokenSet): AuthFnSocialProfile {
  const claims = parseIdTokenClaims(tokenSet.idToken);
  if (!claims.sub || !claims.email) {
    throw new AuthFnOAuthCallbackInvalidError('Apple OAuth callback missing required claims', {
      provider: 'apple'
    });
  }

  // The email and its verified flag come only from the token, and the email
  // counts as verified only when the token says so.
  const emailVerified = claims.emailVerified === true;
  return {
    providerAccountId: claims.sub,
    email: normalizeEmail(claims.email),
    emailVerified,
    name: claims.name,
    profile: cleanObject({
      sub: claims.sub,
      email: normalizeEmail(claims.email),
      emailVerified,
      name: claims.name
    })
  };
}

function resolveAppleFormPostProfile(
  verifiedClaims: JWTPayload,
  userPayload: string | undefined,
  expectedNonce: string | undefined
): AuthFnSocialProfile {
  const claims = readIdTokenClaims(verifiedClaims as Record<string, unknown>);
  if (!claims.sub) {
    throw new AuthFnOAuthCallbackInvalidError('Apple OAuth form_post callback missing subject claim', {
      provider: 'apple'
    });
  }

  if (!expectedNonce || claims.nonce !== expectedNonce) {
    throw new AuthFnOAuthCallbackInvalidError('Apple OAuth form_post nonce mismatch', {
      provider: 'apple'
    });
  }

  // `user` is unsigned request data (Apple posts it through the browser), so it
  // supplies the display name only. The email and its verified flag come only
  // from the verified identity token.
  const user = parseAppleUserPayload(userPayload);
  const email = normalizeEmail(claims.email);
  if (!email) {
    throw new AuthFnOAuthCallbackInvalidError('Apple OAuth form_post callback missing email claim', {
      provider: 'apple'
    });
  }

  const name = resolveAppleDisplayName(user) ?? claims.name;
  const emailVerified = claims.emailVerified === true;
  return {
    providerAccountId: claims.sub,
    email,
    emailVerified,
    name,
    profile: cleanObject({
      sub: claims.sub,
      email,
      emailVerified,
      name,
      firstName: user?.name?.firstName,
      lastName: user?.name?.lastName
    })
  };
}

async function resolveAppleNativeProfile(
  identityToken: string,
  userPayload: NativeAppleCompleteBody['user'] | undefined,
  expectedNonce: string | undefined,
  audience: string | string[]
): Promise<AuthFnSocialProfile> {
  const claims = await verifyAppleIdentityToken(identityToken, audience);
  const subject = readOptionalString(claims.sub);
  if (!subject) {
    throw new AuthFnOAuthCallbackInvalidError('Apple native identity token missing subject claim', {
      provider: 'apple'
    });
  }

  const nonce = readOptionalString(claims.nonce);
  if (!expectedNonce || nonce !== expectedNonce) {
    throw new AuthFnOAuthCallbackInvalidError('Apple native identity token nonce mismatch', {
      provider: 'apple'
    });
  }

  // The request body is unsigned, so `user` supplies the display name only.
  // The email and its verified flag come only from the verified identity
  // token. A token without an email resolves the identity by subject alone:
  // an Apple ID already linked still signs in, and a new one creates an
  // account without an email, so nothing is linked or marked verified by email.
  const email = normalizeEmail(readOptionalString(claims.email));

  const firstName = readOptionalString(userPayload?.name?.firstName);
  const lastName = readOptionalString(userPayload?.name?.lastName);
  const payloadName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const name = readOptionalString(claims.name) ?? (payloadName || undefined);
  const emailVerified = email !== undefined && readBooleanClaim(claims.email_verified) === true;

  return {
    providerAccountId: subject,
    email,
    emailVerified,
    name,
    profile: cleanObject({
      sub: subject,
      email,
      emailVerified: email === undefined ? undefined : emailVerified,
      name,
      firstName,
      lastName,
      isPrivateEmail: readBooleanClaim(claims.is_private_email)
    })
  };
}

async function verifyAppleIdentityToken(
  identityToken: string,
  audience: string | string[]
): Promise<JWTPayload> {
  try {
    const result = await jwtVerify(identityToken, APPLE_JWKS, {
      issuer: 'https://appleid.apple.com',
      audience
    });
    return result.payload;
  } catch (error) {
    throw new AuthFnOAuthCallbackInvalidError('Apple native identity token verification failed', {
      provider: 'apple',
      reason: error instanceof Error ? error.message : 'verification_failed'
    });
  }
}

// Reads only the name from Apple's unsigned `user` payload. Its `email` is
// deliberately ignored: the email must come from the verified identity token.
function parseAppleUserPayload(value: string | undefined): {
  name?: {
    firstName?: string;
    lastName?: string;
  };
} | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const name = readRecord(parsed.name);
    return {
      name: name
        ? {
            firstName: readOptionalString(name.firstName),
            lastName: readOptionalString(name.lastName)
          }
        : undefined
    };
  } catch {
    return undefined;
  }
}

function resolveAppleDisplayName(user: ReturnType<typeof parseAppleUserPayload>): string | undefined {
  const name = [
    user?.name?.firstName,
    user?.name?.lastName
  ].filter(Boolean).join(' ').trim();
  return name || undefined;
}

async function resolveGitHubProfile(
  tokenSet: SocialTokenSet,
  fetcher: OAuthFetchLike | undefined
): Promise<AuthFnSocialProfile> {
  const http = fetcher ?? createGlobalFetchLike();
  const userResponse = await http('https://api.github.com/user', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${tokenSet.accessToken}`,
      accept: 'application/json'
    }
  });
  if (!userResponse.ok) {
    throw new AuthFnOAuthCallbackInvalidError('GitHub profile request failed', {
      provider: 'github',
      status: userResponse.status
    });
  }

  const userPayload = await readJsonRecord(userResponse);
  const emailResponse = await http('https://api.github.com/user/emails', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${tokenSet.accessToken}`,
      accept: 'application/json'
    }
  });
  if (!emailResponse.ok) {
    throw new AuthFnOAuthCallbackInvalidError('GitHub email request failed', {
      provider: 'github',
      status: emailResponse.status
    });
  }

  const emails = await readJsonArray(emailResponse);
  const primaryEmail = emails.find((entry) => entry.primary === true)
    ?? emails.find((entry) => entry.verified === true)
    ?? emails[0];
  const providerAccountId = readIdentifierString(userPayload.id, 'providerAccountId');
  const email = normalizeEmail(readOptionalString(primaryEmail?.email) ?? readOptionalString(userPayload.email));
  const emailVerified = primaryEmail?.verified === true;

  return {
    providerAccountId,
    email,
    emailVerified,
    name: readOptionalString(userPayload.name) ?? readOptionalString(userPayload.login),
    profile: cleanObject({
      id: providerAccountId,
      login: readOptionalString(userPayload.login),
      email,
      emailVerified,
      name: readOptionalString(userPayload.name) ?? readOptionalString(userPayload.login)
    })
  };
}

// This is the largest utf8mb4 VARCHAR that remains fully indexable under
// InnoDB's 3,072-byte key limit. It preserves every legacy connection ID that
// could participate in the existing exact unique MySQL index.
const OAUTH_CONNECTION_ID_MAX_LENGTH = 768;

function createOAuthSharedSchemas(): TableSchema[] {
  return getOAuthStorageTableDefinitions().map((table) => {
    const keyFields = new Set(
      table.fields
        .filter((field) => field.primaryKey || field.unique)
        .map((field) => field.name)
    );
    for (const index of table.indexes ?? []) {
      for (const field of index.fields) keyFields.add(field);
    }

    return {
      modelName: table.name,
      fields: Object.fromEntries(
        table.fields.map((field) => [
          field.name,
          {
            type: mapOAuthFieldType(field.type),
            required: !field.nullable,
            unique: field.primaryKey || field.unique,
            fieldName: field.name,
            ...(field.type === 'text' && keyFields.has(field.name)
              ? { maxLength: field.name === 'connection_id' ? OAUTH_CONNECTION_ID_MAX_LENGTH : 255 }
              : {})
          }
        ])
      ),
      indexes: table.indexes?.map((index) => ({
        name: index.name,
        fields: [...index.fields],
        unique: index.unique
      }))
    };
  });
}

function createOAuthAccountsSchema(): TableSchema {
  return {
    modelName: 'oauth_accounts',
    fields: {
      id: { type: 'string', required: true, fieldName: 'id', maxLength: 255 },
      userId: {
        type: 'string',
        required: true,
        fieldName: 'user_id',
        maxLength: AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH,
        references: { model: 'users', field: 'id', onDelete: 'cascade' }
      },
      provider: { type: 'string', required: true, fieldName: 'provider', maxLength: 255 },
      providerAccountId: { type: 'string', required: true, fieldName: 'provider_account_id', maxLength: 255 },
      connectionId: {
        type: 'string',
        required: true,
        fieldName: 'connection_id',
        maxLength: OAUTH_CONNECTION_ID_MAX_LENGTH
      },
      email: { type: 'string', required: false, fieldName: 'email' },
      profile: { type: 'json', required: false, fieldName: 'profile' },
      createdAt: { type: 'date', required: true, fieldName: 'created_at' },
      updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
    },
    indexes: [
      {
        name: 'idx_authfn_oauth_accounts_connection_id',
        fields: ['connectionId'],
        unique: true
      },
      {
        name: 'idx_authfn_oauth_accounts_provider_account',
        fields: ['provider', 'providerAccountId'],
        unique: true
      },
      {
        name: 'idx_authfn_oauth_accounts_user_id',
        fields: ['userId']
      }
    ]
  };
}

function mapOAuthFieldType(type: 'text' | 'json' | 'boolean'): 'string' | 'json' | 'boolean' {
  switch (type) {
    case 'json':
      return 'json';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

function redirectWithCookies(
  request: Request,
  location: string,
  cookies: string[],
  status: 302 | 303
): Response {
  const headers = new Headers();
  headers.set('location', location);
  headers.set('x-request-id', resolveRequestId(request));
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }

  return new Response(null, {
    status,
    headers
  });
}

async function resolveOAuthCallbackErrorRedirectTarget(
  config: AuthFnRuntimeConfig,
  settings: ResolvedProviderSettings,
  stateId: string
): Promise<string | undefined> {
  const stateStore = new DbAdapterOAuthStateStore(
    withNamespace(config.database, config.namespace ?? 'authfn')
  );
  const state = await stateStore.get(stateId);
  const subject = state?.subject;
  if (!subject || subject.kind !== 'browser-auth') {
    return undefined;
  }

  const callbackMode = normalizeCallbackMode(
    readOptionalString(subject.metadata?.[CALLBACK_METADATA_MODE])
      ?? inferCallbackMode(subject.returnTo)
  );
  if (callbackMode !== 'redirect' || !subject.returnTo) {
    return undefined;
  }

  assertAllowedReturnTarget(settings, subject.returnTo, 'redirect');
  return subject.returnTo;
}

function appendOAuthErrorToReturnTarget(
  returnTo: string,
  providerId: AuthFnSocialProviderId,
  requestId: string,
  error: AuthFnError
): string {
  const url = parseReturnTarget(returnTo);
  url.searchParams.set('auth_error', 'oauth_callback_failed');
  url.searchParams.set('auth_error_code', error.code);
  url.searchParams.set('auth_provider', providerId);
  url.searchParams.set('auth_request_id', requestId);
  return formatReturnTarget(returnTo, url);
}

function isDebugErrorLoggingEnabled(): boolean {
  const globalProcess = globalThis as unknown as {
    process?: {
      env?: Record<string, string | undefined>;
    };
  };
  return globalProcess.process?.env?.AUTHFN_DEBUG_ERRORS === 'true';
}

function summarizeOAuthFailureError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') {
    return {
      type: typeof error,
      message: String(error)
    };
  }

  const raw = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    status?: unknown;
    retryable?: unknown;
    details?: Record<string, unknown>;
    cause?: unknown;
  };

  return {
    name: error instanceof Error ? error.name : raw.name,
    code: raw.code,
    message: error instanceof Error ? error.message : raw.message,
    status: raw.status,
    retryable: raw.retryable,
    details: sanitizeOAuthFailureDetails(raw.details),
    cause: summarizeErrorCause(raw.cause)
  };
}

function summarizeErrorCause(cause: unknown): Record<string, unknown> | string | undefined {
  if (!cause) {
    return undefined;
  }
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message
    };
  }
  if (typeof cause === 'string') {
    return cause;
  }
  if (typeof cause === 'object') {
    const raw = cause as Record<string, unknown>;
    return {
      name: raw.name,
      code: raw.code,
      message: raw.message
    };
  }
  return String(cause);
}

function sanitizeOAuthFailureDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      isSensitiveOAuthFailureKey(key) ? '[REDACTED]' : sanitizeOAuthFailureValue(value)
    ])
  );
}

function sanitizeOAuthFailureValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOAuthFailureValue(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        isSensitiveOAuthFailureKey(key) ? '[REDACTED]' : sanitizeOAuthFailureValue(entry)
      ])
    );
  }
  return value;
}

function isSensitiveOAuthFailureKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return [
    'access_token',
    'accesstoken',
    'authorization',
    'client_secret',
    'clientsecret',
    'code',
    'cookie',
    'id_token',
    'idtoken',
    'password',
    'privatekey',
    'refresh_token',
    'refreshtoken',
    'secret',
    'set-cookie',
    'token'
  ].some((sensitive) => normalized.includes(sensitive));
}

async function createFormPostCallbackRequest(request: Request): Promise<Request> {
  const form = await request.formData();
  const url = new URL(request.url);
  const code = readFormDataString(form.get('code'));
  const state = readFormDataString(form.get('state'));
  const idToken = readFormDataString(form.get('id_token'));
  const user = readFormDataString(form.get('user'));
  if (code) {
    url.searchParams.set('code', code);
  }
  if (state) {
    url.searchParams.set('state', state);
  }
  if (idToken) {
    url.searchParams.set('id_token', idToken);
  }
  if (user) {
    url.searchParams.set('user', user);
  }

  const headers = new Headers();
  const requestId = request.headers.get('x-request-id');
  if (requestId) {
    headers.set('x-request-id', requestId);
  }
  const cookie = request.headers.get('cookie');
  if (cookie) {
    headers.set('cookie', cookie);
  }
  return new Request(url.toString(), {
    method: 'GET',
    headers
  });
}

function readFormDataString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildSessionHandoffPayload(
  issued: Awaited<ReturnType<typeof issueSession>>
): Record<string, unknown> {
  return {
    type: 'session-token',
    token: issued.sessionToken,
    sessionId: issued.session.id,
    regionId: issued.session.regionId ?? null,
    expiresAt: issued.session.expiresAt?.toISOString() ?? null
  };
}

function appendSessionHandoffToReturnTarget(
  returnTo: string,
  issued: Awaited<ReturnType<typeof issueSession>>
): string {
  const url = parseReturnTarget(returnTo);
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  fragment.set('token', issued.sessionToken);
  fragment.set('sessionId', issued.session.id);
  if (issued.session.regionId) {
    fragment.set('regionId', issued.session.regionId);
  }
  if (issued.session.expiresAt) {
    fragment.set('expiresAt', issued.session.expiresAt.toISOString());
  }
  url.hash = fragment.toString();
  return formatReturnTarget(returnTo, url);
}

function appendTwoFactorChallengeToReturnTarget(
  returnTo: string,
  challengeId: string,
  primaryMethod: string
): string {
  const url = parseReturnTarget(returnTo);
  url.searchParams.set('authfnCode', 'AUTHFN_2FA_REQUIRED');
  url.searchParams.set('challengeId', challengeId);
  url.searchParams.set('primaryMethod', primaryMethod);
  return formatReturnTarget(returnTo, url);
}

function assertAllowedReturnTarget(
  settings: ResolvedProviderSettings,
  returnTo: string | undefined,
  callbackMode: 'redirect' | 'json'
): void {
  if (callbackMode !== 'redirect') {
    return;
  }

  if (!returnTo) {
    throw new AuthFnRedirectUriDisallowedError('Redirect mode requires an allowlisted returnTo target', {
      provider: settings.providerId
    });
  }

  if (!isReturnTargetAllowlisted(returnTo, settings.allowlistedReturnTo)) {
    throw new AuthFnRedirectUriDisallowedError('Redirect target is not allowlisted', {
      provider: settings.providerId,
      returnTo
    });
  }
}

/** Schemes that run script or read local data and are never a return target. */
const FORBIDDEN_RETURN_TARGET_SCHEMES = new Set([
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
  'about:',
  'filesystem:'
]);

function isWebScheme(protocol: string): boolean {
  return protocol === 'https:' || protocol === 'http:';
}

/** Placeholder base used only to edit a relative return target's query and fragment. */
const RELATIVE_RETURN_TARGET_BASE = 'https://relative-return-target.invalid';

/** Parses an allowlisted return target, which may be a same-site path. */
function parseReturnTarget(returnTo: string): URL {
  return isSameOriginPath(returnTo) ? new URL(returnTo, RELATIVE_RETURN_TARGET_BASE) : new URL(returnTo);
}

/**
 * Returns an allowlisted target in the form a Location header accepts:
 * characters outside ASCII (`/会員`) are percent-encoded, and a relative
 * target stays relative.
 */
function serializeReturnTarget(returnTo: string): string {
  return formatReturnTarget(returnTo, parseReturnTarget(returnTo));
}

/** Formats a target edited after parseReturnTarget, keeping a relative one relative. */
function formatReturnTarget(returnTo: string, url: URL): string {
  // href keeps an empty `?` or `#`; pathname + search + hash would drop
  // them, and a target without its own `#` takes the callback URL's fragment.
  return isSameOriginPath(returnTo) ? url.href.slice(url.origin.length) : url.href;
}

/**
 * A path on the current site: starts with one `/` (not `//`, which a browser
 * reads as another host) and has no backslash or control characters, which
 * browsers may also turn into a host change.
 */
function isSameOriginPath(value: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  // Dot segments (`/.//host`, `/%2e//host`) collapse when the target is
  // parsed and edited, and could leave a `//host` redirect, so the parsed
  // path must still start with a single `/` too.
  const resolved = new URL(value, RELATIVE_RETURN_TARGET_BASE);
  return resolved.origin === new URL(RELATIVE_RETURN_TARGET_BASE).origin
    && !resolved.pathname.startsWith('//');
}

/**
 * An entry matches a target when the strings are equal, or when the entry is
 * a bare origin (no path, query or fragment) that covers the target:
 *
 * - `http:`/`https:` entries cover targets with the same origin.
 * - Other schemes have no URL origin (`new URL('myapp://x').origin` is the
 *   string "null" for every one of them), so a bare entry such as
 *   `myapp://oauthsignin` covers only targets with the same scheme, host and
 *   port. An entry without a host (`myapp:`) only matches exactly.
 *
 * Script and local-data schemes are refused whatever the allowlist says.
 */
function isReturnTargetAllowlisted(returnTo: string, allowlist: string[]): boolean {
  // The body is caller JSON, so the declared type is not guaranteed.
  if (typeof returnTo !== 'string') {
    return false;
  }
  let target: URL;
  try {
    target = new URL(returnTo);
  } catch {
    // A relative target (resolved by the browser against the callback's
    // origin) must be listed exactly and be a plain path.
    return isSameOriginPath(returnTo) && allowlist.includes(returnTo);
  }
  if (FORBIDDEN_RETURN_TARGET_SCHEMES.has(target.protocol)) {
    return false;
  }

  if (allowlist.includes(returnTo)) {
    return true;
  }

  return allowlist.some((entry) => {
    try {
      const allowed = new URL(entry);
      const allowsOrigin =
        (allowed.pathname === '/' || allowed.pathname === '')
        && !allowed.search
        && !allowed.hash;
      if (!allowsOrigin || allowed.protocol !== target.protocol) {
        return false;
      }
      if (isWebScheme(allowed.protocol)) {
        return allowed.origin === target.origin;
      }
      return allowed.host !== '' && allowed.host === target.host;
    } catch {
      return false;
    }
  });
}

function buildCallbackUri(baseUrl: string, basePath: string, providerId: AuthFnSocialProviderId): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return `${normalizedBase}${normalizedPath}/social/callback/${providerId}`;
}

function toOAuthFlowSubject(state: {
  subject?: unknown;
  tenantId?: string;
  userId?: string;
  connectionId?: string;
  intentId?: string;
  regionId?: string;
  returnTo?: string;
  metadata?: Record<string, unknown>;
}): OAuthFlowSubject {
  const subject = state.subject;
  if (subject && typeof subject === 'object') {
    const record = subject as Record<string, unknown>;
    if (record.kind === 'connection') {
      return {
        kind: 'connection',
        tenantId: readOptionalString(record.tenantId),
        userId: readOptionalString(record.userId),
        connectionId: readOptionalString(record.connectionId)
      };
    }
    if (record.kind === 'browser-auth') {
      return {
        kind: 'browser-auth',
        tenantId: readOptionalString(record.tenantId),
        intentId: readOptionalString(record.intentId),
        regionId: readOptionalString(record.regionId),
        returnTo: readOptionalString(record.returnTo),
        metadata: readRecord(record.metadata)
      };
    }
  }

  if (state.intentId) {
    return {
      kind: 'browser-auth',
      tenantId: state.tenantId,
      intentId: state.intentId,
      regionId: state.regionId,
      returnTo: state.returnTo,
      metadata: state.metadata
    };
  }

  return {
    kind: 'connection',
    tenantId: state.tenantId,
    userId: state.userId,
    connectionId: state.connectionId
  };
}

function parseIdTokenClaims(idToken: string | undefined): {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  nonce?: string;
} {
  if (!idToken) {
    return {};
  }

  const parts = idToken.split('.');
  if (parts.length < 2) {
    return {};
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return readIdTokenClaims(payload);
  } catch {
    return {};
  }
}

function readIdTokenClaims(payload: Record<string, unknown>): {
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  nonce?: string;
} {
  const fallbackName = [
    readOptionalString(payload.given_name),
    readOptionalString(payload.family_name)
  ].filter(Boolean).join(' ').trim();
  return {
    sub: readOptionalString(payload.sub),
    email: readOptionalString(payload.email),
    emailVerified: readBooleanClaim(payload.email_verified),
    name: readOptionalString(payload.name) ?? (fallbackName || undefined),
    nonce: readOptionalString(payload.nonce)
  };
}

function createConnectionId(providerId: AuthFnSocialProviderId, userId: string): string {
  const digest = createHash('sha256')
    .update(providerId)
    .update('\0')
    .update(userId)
    .update('\0')
    .update(randomBytes(16))
    .digest('hex');
  return `soc_${providerId}_${digest}`;
}

function createIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function buildHookContext(
  config: AuthFnRuntimeConfig,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  actorId?: string,
  session?: SocialCallbackCompletion['session']
): AuthFnHookContext {
  return {
    config,
    request,
    environment: runtime,
    actorId,
    session
  };
}

async function runBeforeOAuthStart(
  ctx: AuthFnPluginRuntimeContext,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  try {
    const transformed = await ctx.hooks.beforeOAuthStart?.(
      buildHookContext(ctx.config, request, runtime),
      input
    );
    return (transformed ?? input) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AuthFnError) {
      throw error;
    }
    throw new AuthFnPluginAbortedError('beforeOAuthStart hook aborted social OAuth start', {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function requireResolvedIdentity(result: OAuthFlowCallbackResult): OAuthFlowResolvedIdentity {
  if (!result.resolvedIdentity) {
    throw new AuthFnOAuthCallbackInvalidError('OAuth callback did not resolve a local authfn identity', {
      provider: result.providerId
    });
  }

  return result.resolvedIdentity;
}

function readStoredCallbackMode(result: OAuthFlowCallbackResult): 'redirect' | 'json' {
  const raw = result.subject.metadata?.[CALLBACK_METADATA_MODE];
  return normalizeCallbackMode(readOptionalString(raw) ?? inferCallbackMode(result.subject.returnTo));
}

function readStoredHandoffMode(
  result: OAuthFlowCallbackResult,
  defaultHandoffMode: AuthFnSocialHandoffMode = 'none'
): AuthFnSocialHandoffMode {
  const raw = result.subject.metadata?.[CALLBACK_METADATA_HANDOFF];
  return normalizeHandoffMode(
    readOptionalString(raw) ?? inferHandoffMode(result.subject.returnTo, readStoredCallbackMode(result), defaultHandoffMode)
  );
}

function normalizeProviderId(value: unknown): AuthFnSocialProviderId {
  if (value === 'google' || value === 'apple' || value === 'github') {
    return value;
  }

  throw new AuthFnOAuthProviderUnsupportedError('Unsupported social OAuth provider', {
    provider: value
  });
}

function normalizeCallbackMode(value: string): 'redirect' | 'json' {
  if (value === 'redirect' || value === 'json') {
    return value;
  }

  throw new AuthFnValidationError('callbackMode must be "redirect" or "json"', {
    callbackMode: value
  });
}

function normalizeHandoffMode(value: string): AuthFnSocialHandoffMode {
  if (value === 'none' || value === 'session-token') {
    return value;
  }

  throw new AuthFnValidationError('handoffMode must be "none" or "session-token"', {
    handoffMode: value
  });
}

function inferCallbackMode(returnTo: string | undefined): 'redirect' | 'json' {
  return returnTo ? 'redirect' : 'json';
}

function inferHandoffMode(
  returnTo: string | undefined,
  callbackMode: 'redirect' | 'json',
  defaultHandoffMode: AuthFnSocialHandoffMode = 'none'
): AuthFnSocialHandoffMode {
  if (callbackMode !== 'redirect' || !returnTo) {
    return 'none';
  }

  try {
    const protocol = new URL(returnTo).protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return 'session-token';
    }
  } catch {
    return defaultHandoffMode;
  }

  return defaultHandoffMode;
}

function readRequiredString(value: unknown, field: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) {
    throw new AuthFnValidationError(`${field} is required`, { field });
  }
  return normalized;
}

function readIdentifierString(value: unknown, field: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return readRequiredString(value, field);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readBooleanClaim(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') {
      return true;
    }
    if (value.toLowerCase() === 'false') {
      return false;
    }
  }
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .map((entry) => readOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length > 0 ? entries : undefined;
}

function normalizeEmail(value: string | undefined): string | undefined {
  const normalized = readOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (!normalized.includes('@')) {
    throw new AuthFnValidationError('A valid email is required', {
      email: value
    });
  }

  return normalized;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cleanObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  );
}

function readResolver(value: unknown): AuthFnSocialProviderConfig['clientSecretResolver'] | undefined {
  return typeof value === 'function'
    ? value as AuthFnSocialProviderConfig['clientSecretResolver']
    : undefined;
}

function readProfileMetadata(metadata: Record<string, unknown> | undefined): AuthFnSocialProfile {
  const profile = metadata?.profile;
  const record = readRecord(profile);
  if (!record) {
    throw new AuthFnOAuthCallbackInvalidError('OAuth callback is missing resolved profile metadata');
  }

  const providerAccountId = readRequiredString(record.providerAccountId, 'providerAccountId');
  return {
    providerAccountId,
    email: normalizeEmail(readOptionalString(record.email)),
    emailVerified: readOptionalBoolean(record.emailVerified),
    name: readOptionalString(record.name),
    profile: record
  };
}

async function readJsonRecord(response: Awaited<ReturnType<OAuthFetchLike>>): Promise<Record<string, unknown>> {
  const payload = JSON.parse(await response.text()) as unknown;
  const record = readRecord(payload);
  if (!record) {
    throw new AuthFnOAuthCallbackInvalidError('OAuth profile response must be a JSON object');
  }
  return record;
}

async function readJsonArray(response: Awaited<ReturnType<OAuthFetchLike>>): Promise<Array<Record<string, unknown>>> {
  const payload = JSON.parse(await response.text()) as unknown;
  if (!Array.isArray(payload)) {
    throw new AuthFnOAuthCallbackInvalidError('OAuth profile response must be a JSON array');
  }
  return payload.map((entry) => readRecord(entry) ?? {});
}

function createGlobalFetchLike(): OAuthFetchLike {
  const fetcher = globalThis.fetch;
  if (!fetcher) {
    throw new AuthFnOAuthCallbackInvalidError('global fetch is not available for GitHub profile resolution');
  }

  return async (url, init) => {
    const response = await fetcher(url, {
      method: init.method,
      headers: init.headers,
      body: init.body
    });

    return {
      ok: response.ok,
      status: response.status,
      headers: {
        get(name: string) {
          return response.headers.get(name);
        }
      },
      text: () => response.text()
    };
  };
}

function withNamespace(adapter: Adapter, namespace: string): Adapter {
  return {
    ...adapter,
    create: (params) => adapter.create({ ...params, namespace: params.namespace ?? namespace }),
    findOne: (params) => adapter.findOne({ ...params, namespace: params.namespace ?? namespace }),
    findMany: (params) => adapter.findMany({ ...params, namespace: params.namespace ?? namespace }),
    update: (params) => adapter.update({ ...params, namespace: params.namespace ?? namespace }),
    delete: (params) => adapter.delete({ ...params, namespace: params.namespace ?? namespace }),
    createMany: (params) => adapter.createMany({ ...params, namespace: params.namespace ?? namespace }),
    updateMany: (params) => adapter.updateMany({ ...params, namespace: params.namespace ?? namespace }),
    deleteMany: (params) => adapter.deleteMany({ ...params, namespace: params.namespace ?? namespace }),
    upsert: (params) => adapter.upsert({ ...params, namespace: params.namespace ?? namespace }),
    count: (params) => adapter.count({ ...params, namespace: params.namespace ?? namespace })
  } as Adapter;
}

type SocialTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
  idToken?: string;
};

function readHandoffChallenge(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const challenge = typeof value === 'string' ? value : '';
  if (!HANDOFF_CHALLENGE_PATTERN.test(challenge)) {
    throw new AuthFnValidationError('handoffChallenge must be a base64url SHA-256 digest', {
      field: 'handoffChallenge'
    });
  }
  return challenge;
}

/**
 * Applies the server-side handoff policy: session tokens are only delivered to
 * web URLs when explicitly allowed, and native handoffs can be required to use
 * the code-and-verifier exchange.
 */
function assertAllowedHandoff(
  config: ResolvedSocialOAuthPluginConfig,
  input: {
    returnTo: string | undefined;
    callbackMode: 'redirect' | 'json';
    handoffMode: AuthFnSocialHandoffMode;
    handoffChallenge: string | undefined;
  }
): void {
  if (input.handoffMode !== 'session-token' || input.callbackMode !== 'redirect') {
    return;
  }
  if (config.allowWebSessionTokenHandoff === false && isWebReturnTarget(input.returnTo)) {
    throw new AuthFnValidationError('Session-token handoff is only available for native return targets', {
      field: 'handoffMode'
    });
  }
  if (config.requireHandoffChallenge && !input.handoffChallenge) {
    throw new AuthFnValidationError('Session-token handoff requires handoffChallenge', {
      field: 'handoffChallenge'
    });
  }
}

function isWebReturnTarget(returnTo: string | undefined): boolean {
  if (!returnTo) {
    return false;
  }
  try {
    const protocol = new URL(returnTo).protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    // A relative target is a page on the web.
    return isSameOriginPath(returnTo);
  }
}

function createBrowserBindingNonce(): string {
  return randomBytes(24).toString('base64url');
}

function hashBindingValue(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/**
 * One binding cookie per pending sign-in, so overlapping sign-ins in the same
 * browser do not overwrite each other. On https it is a `__Host-` cookie
 * (Secure, Path=/, no Domain), so a sibling subdomain cannot plant it.
 */
function browserBindingCookieName(prefix: string, secure: boolean, stateId: string): string {
  const suffix = createHash('sha256').update(stateId).digest('base64url').slice(0, 16);
  return `${secure ? '__Host-' : ''}${prefix}.oauth_binding.${suffix}`;
}

/**
 * The binding cookie only carries a random nonce, never a credential. Apple
 * returns with a cross-site form POST, so on https it uses SameSite=None.
 */
function serializeBrowserBindingCookie(
  ctx: AuthFnPluginRuntimeContext,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  stateId: string,
  value: string,
  expiresAt: string | undefined
): string {
  const policy = resolveCookiePolicy(ctx.config, request, runtime);
  const secure = bindingCookieSecure(policy.secure, runtime);
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const maxAge = Number.isFinite(expiresAtMs)
    ? Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000))
    : 600;
  return serializeSetCookie({
    name: browserBindingCookieName(policy.prefix, secure, stateId),
    value,
    path: '/',
    secure,
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    maxAge
  });
}

function clearBrowserBindingCookie(
  ctx: AuthFnPluginRuntimeContext,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  stateId: string
): string {
  const policy = resolveCookiePolicy(ctx.config, request, runtime);
  const secure = bindingCookieSecure(policy.secure, runtime);
  return serializeSetCookie({
    name: browserBindingCookieName(policy.prefix, secure, stateId),
    value: '',
    path: '/',
    secure,
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    maxAge: 0,
    expires: new Date(0)
  });
}

/**
 * With `bindBrowserState`, refuses a callback unless this browser holds the
 * binding cookie set when the sign-in started. The only unbound states allowed
 * are code-and-verifier handoffs, whose callback sets no session cookies.
 */
async function assertBrowserBinding(
  ctx: AuthFnPluginRuntimeContext,
  config: ResolvedSocialOAuthPluginConfig,
  request: Request,
  runtime: AuthFnSocialOAuthEnvironment,
  stateId: string
): Promise<void> {
  const stateStore = new DbAdapterOAuthStateStore(
    withNamespace(ctx.config.database, ctx.config.namespace ?? 'authfn')
  );
  const state = await stateStore.get(stateId);
  const subject = state?.subject;
  const metadata = subject?.kind === 'browser-auth' ? subject.metadata : undefined;
  const expected = readOptionalString(metadata?.[CALLBACK_METADATA_BINDING]);
  if (!expected) {
    if (config.bindBrowserState && state && !isHandoffCodeFlow(metadata, config.defaultHandoffMode)) {
      throw new AuthFnOAuthStateInvalidError('OAuth sign-in was not bound to a browser');
    }
    return;
  }
  const policy = resolveCookiePolicy(ctx.config, request, runtime);
  const secure = bindingCookieSecure(policy.secure, runtime);
  const provided = readCookie(request, browserBindingCookieName(policy.prefix, secure, stateId));
  if (!provided || !safeEqual(hashBindingValue(provided), expected)) {
    throw new AuthFnOAuthStateInvalidError('OAuth sign-in was started in a different browser');
  }
}

/**
 * The binding cookie must reach Apple's cross-site form POST, so it is Secure
 * and SameSite=None whenever the public origin is https, even when the session
 * cookie is configured without `secure` (for example behind a TLS proxy).
 */
function bindingCookieSecure(sessionCookieSecure: boolean, runtime: AuthFnSocialOAuthEnvironment): boolean {
  return sessionCookieSecure || isHttpsOrigin(runtime.baseUrl);
}

function isHttpsOrigin(value: string | undefined): boolean {
  try {
    return value ? new URL(value).protocol === 'https:' : false;
  } catch {
    return false;
  }
}

/** True for a redirect session-token start with a handoff challenge: its callback sets no cookies. */
function isHandoffCodeFlow(
  metadata: Record<string, unknown> | undefined,
  defaultHandoffMode: AuthFnSocialHandoffMode | undefined
): boolean {
  if (!readOptionalString(metadata?.[CALLBACK_METADATA_HANDOFF_CHALLENGE])) {
    return false;
  }
  const callbackMode = readOptionalString(metadata?.[CALLBACK_METADATA_MODE]);
  const handoffMode = readOptionalString(metadata?.[CALLBACK_METADATA_HANDOFF]) ?? defaultHandoffMode;
  return callbackMode === 'redirect' && handoffMode === 'session-token';
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifierMatchesChallenge(verifier: string, challenge: string | undefined): boolean {
  if (!challenge || verifier.length < 43 || verifier.length > 128) {
    return false;
  }
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

function socialHandoffStateId(code: string): string {
  return `${SOCIAL_HANDOFF_STATE_PREFIX}${createHash('sha256').update(code).digest('hex')}`;
}

/** Stores a one-time handoff code (hashed) that the verifier holder can exchange for a session. */
async function createSocialHandoffCode(
  ctx: AuthFnPluginRuntimeContext,
  config: ResolvedSocialOAuthPluginConfig,
  input: {
    providerId: AuthFnSocialProviderId;
    redirectUri: string;
    userId: string;
    regionId?: string;
    methods: string[];
    challenge: string;
    /** The provider-account link the sign-in went through. */
    oauthAccountId?: string;
  }
): Promise<string> {
  const code = `shc_${randomBytes(24).toString('base64url')}`;
  const now = config.now?.() ?? new Date();
  const ttlSeconds = config.handoffCodeTtlSeconds ?? DEFAULT_SOCIAL_HANDOFF_CODE_TTL_SECONDS;
  const stateStore = new DbAdapterOAuthStateStore(
    withNamespace(ctx.config.database, ctx.config.namespace ?? 'authfn')
  );
  await stateStore.put({
    stateId: socialHandoffStateId(code),
    providerId: input.providerId,
    redirectUri: input.redirectUri,
    requestedScopes: [],
    subject: {
      kind: 'browser-auth',
      intentId: createIdentifier('handoff'),
      regionId: input.regionId,
      metadata: {
        kind: SOCIAL_HANDOFF_KIND,
        userId: input.userId,
        methods: input.methods,
        challenge: input.challenge,
        oauthAccountId: input.oauthAccountId
      }
    },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString()
  });
  return code;
}

/**
 * Sends the one-time code to the native return target. The code travels in the
 * `token` fragment parameter so existing native shells forward it unchanged;
 * `handoff=code` tells the client to exchange it with its verifier.
 */
function appendHandoffCodeToReturnTarget(returnTo: string, code: string, regionId: string | undefined): string {
  const url = parseReturnTarget(returnTo);
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  fragment.set('token', code);
  fragment.set('handoff', 'code');
  if (regionId) {
    fragment.set('regionId', regionId);
  }
  url.hash = fragment.toString();
  return formatReturnTarget(returnTo, url);
}
