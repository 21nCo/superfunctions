import type { ConditionalKVStoreAdapter, TableSchema } from '@superfunctions/db';
import type { ObservabilityInput } from '@superfunctions/observability';
import type { AuthFnPlugin } from './types.js';
import type {
  AuthFnCookieConfig,
  AuthFnDeliveryMessageResolver,
  AuthFnPasswordCompromiseChecker,
  AuthFnEnvironment,
  AuthFnDeliveryProvider,
  AuthFnEvent
} from './types.js';

export interface AuthFnBundledPluginConfig {
  schema?: TableSchema[];
}

export interface PasswordPluginConfig extends AuthFnBundledPluginConfig {
  compromisedPasswordChecker?: AuthFnPasswordCompromiseChecker;
  requireEmailVerifiedForSignIn?: boolean;
  /** @deprecated Configure password OTP delivery through pluginRuntime.password.otp. */
  otp?: Partial<EmailOtpPluginRuntimeConfig>;
}
export interface PasswordPluginRuntimeConfig {
  /** OTP delivery and challenge settings used by password sign-up, sign-in, and reset flows. */
  otp?: EmailOtpPluginRuntimeConfig;
}
export interface EmailOtpPluginConfig extends AuthFnBundledPluginConfig {
}
export interface EmailOtpPluginRuntimeConfig {
  /** Provider responsible for sending OTP challenges and receiving OTP lifecycle events. */
  delivery: AuthFnDeliveryProvider;
  /** Optional resolver used to customize the OTP message before it is passed to the delivery provider. */
  message?: AuthFnDeliveryMessageResolver;
  /** Optional code generator for tests or custom OTP formats; defaults to the built-in numeric generator. */
  codeGenerator?: () => string;
  /** Clock source used for challenge creation and expiry checks; primarily useful for tests. */
  now?: () => Date;
  /** Number of seconds before an OTP challenge expires. */
  challengeTtlSeconds?: number;
  /** Maximum verification attempts allowed before a challenge is rejected. */
  maxAttempts?: number;
  /**
   * Maximum wrong codes accepted for one email, across all of its challenges
   * and purposes, within `emailAttemptWindowSeconds`. Further verifications
   * for that email are refused with `AUTHFN_RATE_LIMITED` until older
   * challenges leave the window. Defaults to 10.
   */
  maxFailedAttemptsPerEmail?: number;
  /**
   * Maximum challenges that can be created for one email, across purposes,
   * within `emailAttemptWindowSeconds`; further sends are refused with
   * `AUTHFN_RATE_LIMITED`. Defaults to 20.
   */
  maxChallengesPerEmail?: number;
  /**
   * Window, in seconds, for `maxFailedAttemptsPerEmail` and
   * `maxChallengesPerEmail`, measured from each challenge's creation. A
   * challenge that outlives the window keeps counting until it expires.
   * Defaults to 3600.
   */
  emailAttemptWindowSeconds?: number;
}
export interface ApiKeyPluginConfig extends AuthFnBundledPluginConfig {
  secretPrefix?: string;
  /**
   * When set, creating a key needs a cookie session that was signed in within
   * this many seconds. Sessions issued by a handoff from another session do
   * not count as a fresh sign-in. Otherwise the request fails with
   * `AUTHFN_REAUTHENTICATION_REQUIRED` (403).
   */
  recentAuthenticationSeconds?: number;
  /** Expiry applied, in seconds from creation, when a create request omits `expiresAt`. */
  defaultExpiresInSeconds?: number;
  /** Longest allowed lifetime in seconds; later `expiresAt` values are rejected. */
  maxExpiresInSeconds?: number;
}
export interface ApiKeyPluginRuntimeConfig {
  /** Clock source used for API key timestamps and expiry checks; primarily useful for tests. */
  now?: () => Date;
}
export interface TwoFactorPluginConfig extends AuthFnBundledPluginConfig {
}
export interface TwoFactorPluginRuntimeConfig {
  /** Issuer name displayed by authenticator apps for generated TOTP enrollments. */
  issuer?: string;
  /** Clock source used for TOTP challenge creation and verification; primarily useful for tests. */
  now?: () => Date;
  /** Number of seconds before a two-factor challenge expires. */
  challengeTtlSeconds?: number;
  /** Number of recovery codes generated for each confirmed enrollment. */
  recoveryCodeCount?: number;
  /** Number of digits in generated TOTP codes. */
  digits?: number;
  /** TOTP time-step duration in seconds. */
  periodSeconds?: number;
  /** Number of adjacent TOTP windows accepted during verification. */
  window?: number;
  /** Key reference passed to encryptionKeyResolver when encrypting two-factor secrets. */
  encryptionKeyRef?: string;
  /** Resolves the encryption key used for two-factor secret storage. */
  encryptionKeyResolver?: (keyRef: string) => Promise<Buffer> | Buffer;
}

export interface NativeHandoffPluginConfig extends AuthFnBundledPluginConfig {
  codeTtlSeconds?: number;
  /**
   * Registers the native-to-web routes (`/handoff/web/start` and
   * `/handoff/web/consume`). Defaults to true; turn off when no app opens web
   * pages signed in as the native user.
   */
  webHandoff?: boolean;
  /**
   * Requires every web handoff to be bound to the app that started it:
   * `/handoff/web/start` must send `verifierChallenge`, and consume refuses any
   * code without one. Without this, the caller of `/handoff/web/start` (who
   * may be an attacker using their own session) decides whether a code is bound.
   */
  requireWebHandoffVerifier?: boolean;
}
export interface NativeHandoffPluginRuntimeConfig {
  /** Clock source used for native handoff code timestamps and expiry checks; primarily useful for tests. */
  now?: () => Date;
}

export interface AuthFnMultiRegionRegionConfig {
  regionId: string;
  authority: string;
  domain?: string;
  hosts?: string[];
  issuer?: string;
  baseUrl?: string;
  cookie?: Partial<AuthFnCookieConfig>;
  oauth?: AuthFnEnvironment['oauth'];
}

export interface AuthFnMultiRegionLookupInput {
  identifier: string;
  request?: Request;
  environment: AuthFnEnvironment;
}

export interface AuthFnMultiRegionLookupResult {
  userId?: string;
  regionId: string;
  authority: string;
  domain?: string;
}

export interface AuthFnMultiRegionRegistrationInput {
  userId: string;
  primaryEmail?: string;
  regionId: string;
  authority: string;
  domain?: string;
  request?: Request;
  environment: AuthFnEnvironment;
}

export interface AuthFnRegionLookupRecord {
  identifier: string;
  userId?: string;
  regionId: string;
  authority: string;
  domain?: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type AuthFnIdentityPlacementState = 'active' | 'moving' | 'deleting' | 'tombstoned';

/**
 * Canonical ownership record for an AuthFn identity. The directory owns only
 * placement metadata; cell destinations remain private to the cell registry.
 */
export interface AuthFnIdentityPlacement {
  identityKey: string;
  regionId: string;
  epoch: number;
  state: AuthFnIdentityPlacementState;
  movingToRegionId?: string;
  previousRegionId?: string;
  updatedAt: Date | string;
}

export interface AuthFnIdentityPlacementDirectoryAdapter {
  /** Strongly consistent with every successful claim and epoch transition. */
  get(identityKey: string): Promise<AuthFnIdentityPlacement | null>;
  /** Globally atomic across every gateway writer for the same identity key. */
  putIfAbsent(placement: AuthFnIdentityPlacement): Promise<{
    inserted: boolean;
    existing?: AuthFnIdentityPlacement;
  }>;
  /** Globally atomic across every writer and fenced by both epoch and state. */
  compareAndSet(input: {
    identityKey: string;
    expectedEpoch: number;
    expectedState: AuthFnIdentityPlacementState;
    placement: AuthFnIdentityPlacement;
  }): Promise<{
    updated: boolean;
    existing?: AuthFnIdentityPlacement;
  }>;
}

export interface AuthFnRoutingSigningKey {
  keyId: string;
  secret: string | Uint8Array;
}

export interface AuthFnRoutingKeyring {
  active: AuthFnRoutingSigningKey;
  /** Verification-only keys retained during rotation. */
  previous?: AuthFnRoutingSigningKey[];
}

export interface AuthFnRoutingReplayStore {
  /** Atomically claims a nonce until its expiry. False means replay. */
  claim(nonce: string, expiresAt: number): Promise<boolean>;
}

interface AuthFnCanonicalRoutingBase {
  /** Stable public issuer/base URL used for discovery, OAuth, and cookies. */
  publicAuthority?: string;
  /** Canonical cookie policy. In gateway mode this must not vary by cell. */
  canonicalCookie?: Partial<AuthFnCookieConfig>;
  /** Canonical OAuth policy merged independently of the execution cell. */
  canonicalOAuth?: AuthFnEnvironment['oauth'];
}

export interface AuthFnDirectRoutingConfig extends AuthFnCanonicalRoutingBase {
  mode: 'direct';
  placementDirectory?: never;
  identityKeyForIdentifier?: never;
  identityKeyForUserId?: never;
  cell?: never;
}

export interface AuthFnGatewayRoutingConfig extends AuthFnCanonicalRoutingBase {
  mode: 'gateway';
  publicAuthority: string;
  /** Required in gateway mode on both the gateway and regional cells. */
  placementDirectory: AuthFnIdentityPlacementDirectoryAdapter;
  /** Maps normalized public identifiers to the same stable key used by the gateway. */
  identityKeyForIdentifier: (identifier: string) => string;
  /** Resolves persisted user IDs to the exact stable placement key used by the gateway. */
  identityKeyForUserId: (userId: string) => string | Promise<string>;
  /** Required by a regional cell to validate gateway assertions. */
  cell?: {
    regionId: string;
    audience: string;
    keyring: AuthFnRoutingKeyring;
    replayStore: AuthFnRoutingReplayStore;
    clockSkewSeconds?: number;
  };
}

export type AuthFnCanonicalRoutingConfig =
  | AuthFnDirectRoutingConfig
  | AuthFnGatewayRoutingConfig;

export interface MultiRegionPluginConfig extends AuthFnBundledPluginConfig {
}

export interface MultiRegionPluginRuntimeConfig {
  /** Region definitions available to the multi-region resolver and routing plugin. */
  regions?: AuthFnMultiRegionRegionConfig[];
  /** Region ID used when no request host or identifier lookup selects another region. */
  defaultRegionId?: string;
  /** Store used to look up and register the region that owns a user identifier. */
  lookupStore?: ConditionalKVStoreAdapter;
  /** Observability sink for multi-region lookup, registration, and conflict events. */
  observability?: ObservabilityInput<AuthFnEvent>;
  /** Canonical-gateway routing. Omit (or use direct) for legacy regional clients. */
  routing?: AuthFnCanonicalRoutingConfig;
}

export type AuthFnPluginFactory<TConfig extends AuthFnBundledPluginConfig> = (
  config?: TConfig
) => AuthFnPlugin;
