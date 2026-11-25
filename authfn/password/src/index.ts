import type { Route } from '@superfunctions/http';
import type {
  PasswordPluginConfig,
  PasswordPluginRuntimeConfig
} from 'authfn/plugin-types';
import {
  AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH,
  type AuthFnPlugin,
  type AuthFnPluginRuntimeContext,
  type AuthFnSchemaDefinition
} from 'authfn';
import { createAuthFnRouteMeta, readOptionalJson } from 'authfn/http/router';
import { authenticateAccountRequest, issueSession, revokeSessionById } from 'authfn/core/sessions';
import { resolveEnvironment } from 'authfn/core/environment';
import { getPasswordCredentialByUserId, signInWithPassword, signUpWithPassword } from 'authfn/core/passwords';
import { AuthFnInvalidCredentialsError } from 'authfn/core/errors';
import { jsonSuccess } from 'authfn/http/envelopes';
import { assertOtpEmailBudgetConfig, completeResetPassword, sendOtpChallenge } from 'authfn/core/verifications';
import { emitAuthEvent, eventRequestId } from 'authfn/core/observability';
import { emitAccountLinkedEvent } from 'authfn/core/account-linking';
import { buildSessionResponse, type AuthFnSessionResponseMode } from 'authfn/core/session-responses';
import {
  beginTwoFactorChallenge,
  createPendingTwoFactorResponse,
  getTwoFactorPluginConfig
} from 'authfn/core/two-factor';
import { readPluginRuntimeConfig } from 'authfn/core/plugin-runtime';

export type {
  PasswordPluginConfig,
  PasswordPluginRuntimeConfig
} from 'authfn/plugin-types';

export function authFnPasswordPlugin(
  config: PasswordPluginConfig = {}
): AuthFnPlugin<'password', PasswordPluginRuntimeConfig, false> & { readonly otpEmailLimits: PasswordOtpEmailLimits } {
  // One snapshot of the factory `otp` options for the routes, the startup
  // check and the published limits, so later changes to the caller's object
  // cannot make them disagree. Other options are read as before.
  const factoryOtp: PasswordPluginConfig['otp'] = config.otp ? { ...config.otp } : undefined;
  return {
    name: 'password',
    // Read by core so every OTP route applies these deprecated limits.
    otpEmailLimits: {
      maxFailedAttemptsPerEmail: factoryOtp?.maxFailedAttemptsPerEmail,
      maxChallengesPerEmail: factoryOtp?.maxChallengesPerEmail,
      emailAttemptWindowSeconds: factoryOtp?.emailAttemptWindowSeconds,
      // Reset codes may live this long, so every route's scan must reach them.
      challengeTtlSeconds: factoryOtp?.challengeTtlSeconds
    },
    schema: () => config.schema ?? createPasswordSchema(),
    validateConfig: (runtime) => assertOtpEmailBudgetConfig(runtime, {
      // The same merge the routes use, so the lifetime checked is theirs.
      ...factoryOtp,
      ...readPluginRuntimeConfig<PasswordPluginRuntimeConfig>(runtime, 'password').otp
    }),
    routes: (ctx) => createPasswordRoutes(ctx, config, factoryOtp)
  };
}

/** Per-email limits from the deprecated `otp` factory options. */
export interface PasswordOtpEmailLimits {
  maxFailedAttemptsPerEmail?: number;
  maxChallengesPerEmail?: number;
  emailAttemptWindowSeconds?: number;
  challengeTtlSeconds?: number;
}

function createPasswordSchema(): AuthFnSchemaDefinition['schemas'] {
  return [
    {
      modelName: 'password_credentials',
      fields: {
        id: { type: 'string', required: true, fieldName: 'id', maxLength: 255 },
        userId: {
          type: 'string',
          required: true,
          fieldName: 'user_id',
          maxLength: AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
        },
        passwordHash: { type: 'string', required: true, fieldName: 'password_hash' },
        createdAt: { type: 'date', required: true, fieldName: 'created_at' },
        updatedAt: { type: 'date', required: true, fieldName: 'updated_at' }
      },
      indexes: [
        {
          name: 'idx_authfn_password_credentials_user_id',
          fields: ['userId'],
          unique: true
        }
      ]
    }
  ];
}

function createPasswordRoutes(
  ctx: AuthFnPluginRuntimeContext,
  config: PasswordPluginConfig,
  factoryOtp: PasswordPluginConfig['otp']
): Route[] {
  const runtimeConfig = readPluginRuntimeConfig<PasswordPluginRuntimeConfig>(ctx, 'password');
  const otpConfig = {
    ...factoryOtp,
    ...runtimeConfig.otp
  };

  return [
    {
      method: 'POST',
      path: '/sign-up/password',
      meta: createAuthFnRouteMeta('signUpWithPassword', 'Create a user and session using email/password', {
        mode: 'none'
      }),
      handler: async (request) => {
        const body = await readOptionalJson<{
          email?: string;
          password?: string;
          profile?: Record<string, unknown>;
          sessionMode?: AuthFnSessionResponseMode;
        }>(request);
        const runtime = await resolveEnvironment(ctx.config, request);
        // Adding a password to the signed-in account needs a session cookie
        // with its CSRF token, or a bearer session token.
        const authenticatedSession = await authenticateAccountRequest(ctx.config, request);
        const result = await signUpWithPassword(ctx.config, ctx.hooks, {
          email: body.email ?? '',
          password: body.password ?? '',
          profile: body.profile
        }, {
          request,
          environment: runtime,
          authenticatedSession,
          policy: {
            compromisedPasswordChecker: config.compromisedPasswordChecker
          }
        });
        if (result.linkedExistingUser) {
          await emitAccountLinkedEvent(ctx.config, {
            request,
            user: result.user,
            method: 'password',
            regionId: runtime.regionId
          });
        } else {
          await emitAuthEvent(ctx.config, {
            type: 'authfn.user.created',
            requestId: eventRequestId(request),
            actorId: result.user.id,
            userId: result.user.id,
            regionId: runtime.regionId,
            outcome: 'created',
            metadata: {
              email: result.user.primaryEmail
            }
          });
        }
        const issued = await issueSession(ctx.config, ctx.hooks, {
          request,
          userId: result.user.id,
          primaryEmail: result.user.primaryEmail,
          methods: ['password']
        });
        const response = buildSessionResponse(issued, body.sessionMode);

        return jsonSuccess(request, response.data, {
          setCookies: response.setCookies
        });
      }
    },
    {
      method: 'POST',
      path: '/password/reset/start',
      meta: createAuthFnRouteMeta('startPasswordReset', 'Start an OTP-backed password reset flow', {
        mode: 'none'
      }),
      handler: async (request) => {
        const body = await readOptionalJson<{
          email?: string;
        }>(request);
        const result = await sendOtpChallenge(ctx.config, ctx.hooks, otpConfig, {
          request,
          purpose: 'reset-password',
          email: body.email ?? ''
        });

        return jsonSuccess(request, {
          challengeId: result.challenge.id,
          sent: result.delivery.sent
        });
      }
    },
    {
      method: 'POST',
      path: '/password/reset/complete',
      meta: createAuthFnRouteMeta('completePasswordReset', 'Complete a password reset with a valid OTP challenge', {
        mode: 'none'
      }),
      handler: async (request) => {
        const body = await request.json() as {
          email?: string;
          code?: string;
          newPassword?: string;
        };
        const result = await completeResetPassword(ctx.config, {
          ...otpConfig,
          passwordPolicy: {
            compromisedPasswordChecker: config.compromisedPasswordChecker
          }
        }, {
          purpose: 'reset-password',
          email: body.email ?? '',
          code: body.code ?? '',
          newPassword: body.newPassword ?? '',
          request
        });

        return jsonSuccess(request, result);
      }
    },
    {
      method: 'POST',
      path: '/sign-in/password',
      meta: createAuthFnRouteMeta('signInWithPassword', 'Sign in and issue a session using email/password', {
        mode: 'none'
      }),
      handler: async (request) => {
        const body = await request.json() as {
          email?: string;
          password?: string;
          sessionMode?: AuthFnSessionResponseMode;
        };
        const result = await signInWithPassword(ctx.config, {
          email: body.email ?? '',
          password: body.password ?? ''
        }, {
          requireEmailVerifiedForSignIn: config.requireEmailVerifiedForSignIn,
          request
        });
        const checkCredentialAfterWrite = async (discard: () => Promise<unknown>) => {
          try {
            const current = await getPasswordCredentialByUserId(ctx.config, result.user.id);
            if (current?.id !== result.credential.id || current.passwordHash !== result.credential.passwordHash) {
              throw new AuthFnInvalidCredentialsError('Invalid email or password');
            }
          } catch (error) {
            await discard();
            throw error;
          }
        };
        const twoFactorConfig = getTwoFactorPluginConfig(ctx.config);
        if (twoFactorConfig) {
          const challenge = await beginTwoFactorChallenge(
            ctx.config,
            result.user,
            'password',
            twoFactorConfig
          );
          if (challenge) {
            const discardChallenge = () =>
              ctx.config.database.delete({
                model: 'two_factor_challenges',
                where: [{ field: 'id', operator: 'eq', value: challenge.challenge.id }],
                namespace: ctx.namespace
              });
            await checkCredentialAfterWrite(discardChallenge);
            await emitAuthEvent(ctx.config, {
              type: 'authfn.2fa.challenged',
              requestId: eventRequestId(request),
              actorId: result.user.id,
              userId: result.user.id,
              outcome: 'required',
              metadata: {
                challengeId: challenge.challenge.id,
                primaryMethod: 'password'
              }
            });
            await checkCredentialAfterWrite(discardChallenge);
            throw createPendingTwoFactorResponse(challenge.challenge);
          }
        }
        const issued = await issueSession(ctx.config, {
          ...ctx.hooks,
          async afterSessionIssue(hookContext, session) {
            // Run before the host's success hook or issueSession's event.
            await checkCredentialAfterWrite(() => revokeSessionById(ctx.config, session.id));
            await ctx.hooks.afterSessionIssue?.(hookContext, session);
          }
        }, {
          request,
          userId: result.user.id,
          primaryEmail: result.user.primaryEmail,
          methods: ['password']
        });
        await checkCredentialAfterWrite(() => revokeSessionById(ctx.config, issued.session.id));
        const response = buildSessionResponse(issued, body.sessionMode);

        return jsonSuccess(request, response.data, {
          setCookies: response.setCookies
        });
      }
    }
  ];
}
