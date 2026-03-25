import { describe, expect, it } from 'vitest';
import {
  AuthFnConflictError,
  authFnApiKeyPlugin,
  authFnEmailOtpPlugin,
  authFnMultiRegionPlugin,
  authFnPasswordPlugin,
  authFnSocialOAuthPlugin,
  authFnTwoFactorPlugin,
  createAuthFn,
  getSchema,
  type AuthFnConfig,
  type AuthFnPlugin
} from '../src/index.js';

const config = (): AuthFnConfig => ({
  database: {} as AuthFnConfig['database'],
  namespace: 'authfn',
  plugins: [
    authFnPasswordPlugin(),
    authFnEmailOtpPlugin(),
    authFnSocialOAuthPlugin(),
    authFnApiKeyPlugin(),
    authFnTwoFactorPlugin(),
    authFnMultiRegionPlugin()
  ]
});

describe('@authfn/core schema composition', () => {
  it('returns deterministic table order for a fixed plugin config', () => {
    const first = getSchema(config());
    const second = getSchema(config());

    expect(first.schemas.map((table) => table.modelName)).toEqual([
      'users',
      'sessions',
      'password_credentials',
      'otp_challenges',
      'oauth_states',
      'oauth_tokens',
      'oauth_consents',
      'oauth_revocation_failures',
      'oauth_accounts',
      'api_keys',
      'two_factor_enrollments',
      'two_factor_recovery_codes',
      'two_factor_challenges',
      'region_profiles'
    ]);
    expect(second).toEqual(first);
  });

  it('fails deterministically on duplicate table names', () => {
    const duplicatePlugin: AuthFnPlugin = {
      name: 'duplicate',
      schema: () => [
        {
          modelName: 'users',
          fields: {
            id: { type: 'string', required: true, fieldName: 'id' }
          }
        }
      ]
    };

    expect(() =>
      getSchema({
        ...config(),
        plugins: [duplicatePlugin]
      })
    ).toThrowError(AuthFnConflictError);
  });

  it('fails deterministically on duplicate column mappings within a table', () => {
    const conflictingPlugin: AuthFnPlugin = {
      name: 'conflicting',
      schema: () => [
        {
          modelName: 'conflicting_table',
          fields: {
            firstField: { type: 'string', required: true, fieldName: 'shared' },
            secondField: { type: 'string', required: true, fieldName: 'shared' }
          }
        }
      ]
    };

    expect(() =>
      getSchema({
        ...config(),
        plugins: [conflictingPlugin]
      })
    ).toThrowError(AuthFnConflictError);
  });

  it('produces stable route output across runs', () => {
    const first = createAuthFn(config()).router.getRoutes().map((route) => `${route.method}:${route.path}`);
    const second = createAuthFn(config()).router.getRoutes().map((route) => `${route.method}:${route.path}`);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(4);
  });
});
