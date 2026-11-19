import { createHash } from 'node:crypto';
import type {
  BillFnCancelSubscriptionInput,
  BillFnChangeSubscriptionInput,
  BillFnCreateCheckoutInput,
  BillFnFetchNotificationHistoryInput,
  BillFnImportSubscriptionInput,
  BillFnNotificationHistoryPage,
  BillFnParsedWebhookEvent,
  BillFnProviderAdapter,
  BillFnProviderOperationResult,
  BillFnRefundChargeInput,
  BillFnRestorePurchasesInput,
  BillFnResumeSubscriptionInput,
  BillFnSyncSubscriptionInput,
  BillFnVerifiedBillingState,
  BillFnVerifyCheckoutInput
} from '@billfn/core';
import { BILLFN_IMPORTED_AT_METADATA_KEY, createBillFnError } from '@billfn/core';
import { createAppStoreServerApiTokenSigner, type AppStoreServerApiKey } from './api-token-signer.js';
import {
  AppleSignedDataVerificationError,
  createAppleSignedDataVerifier,
  type AppleSignedDataVerifier
} from './signed-data-verifier.js';

export {
  createAppStoreServerApiTokenSigner,
  type AppStoreServerApiKey,
  type AppStoreServerApiTokenSignerOptions
} from './api-token-signer.js';
export {
  APPLE_SIGNING_LEAF_OID,
  APPLE_WWDR_INTERMEDIATE_OID,
  AppleSignedDataVerificationError,
  createAppleSignedDataVerifier,
  type AppleEnvironment,
  type AppleSignedDataVerificationFailure,
  type AppleSignedDataVerifier,
  type AppleSignedDataVerifierOptions,
  type AppleVerifiedSignedData
} from './signed-data-verifier.js';
export { APPLE_ROOT_CA_G3, APPLE_ROOT_CA_G3_SHA256 } from './apple-root-ca.js';

export interface AppleNotificationVerifierContext {
  rawBody: string;
  signedPayload: string;
}

/** What a token provider signs for: the bundle ID of the app whose transaction or history is requested. */
export interface AppleTokenProviderContext {
  /** Set whenever the provider is configured with bundleId or bundleIds; the token's `bid` must name it. */
  bundleId: string;
}

/** Returns an App Store Server API bearer token, for the app `context.bundleId` names when it is given. */
export type AppleTokenProvider = (context?: AppleTokenProviderContext) => Promise<string>;

export interface AppleAdvancedCommerceConfig {
  /** Defaults to the provider's App Store Server API token provider. */
  tokenProvider?: AppleTokenProvider;
  baseUrl?: string;
  enabled?: boolean;
}

export interface AppleProviderConfig {
  fetch?: typeof fetch;
  environment?: 'production' | 'sandbox';
  /**
   * The app's bundle ID. With it the built-in verifier checks notifications (x5c chain to the pinned Apple Root CA - G3,
   * Apple's OIDs, ES256 signature, certificate validity, this bundle ID), and the built-in signer claims it.
   */
  bundleId?: string;
  /**
   * The bundle IDs of several apps of one developer team, served by this one adapter (with `bundleId`, if also given).
   * The built-in verifier accepts signed data for any listed app and rejects every other app. App Store Server API
   * requests about a transaction are tried for each listed app in order until one is not StoreKit's not-found answer,
   * so each request's token claims, as `bid`, the app being asked.
   */
  bundleIds?: readonly string[];
  /** The in-app purchase key the built-in signer signs App Store Server API tokens with; requires bundleId or bundleIds. */
  appStoreServerApiKey?: AppStoreServerApiKey;
  /**
   * Overrides the built-in signer. Either this or bundleId (or bundleIds) with appStoreServerApiKey is required. When
   * bundle IDs are configured, it is called with the bundle ID the token must claim as `bid`.
   */
  tokenProvider?: AppleTokenProvider;
  /** Overrides the built-in verifier; it returns the verified notification payload, or null to reject it. */
  notificationVerifier?: (context: AppleNotificationVerifierContext) => Promise<Record<string, unknown> | null>;
  advancedCommerce?: AppleAdvancedCommerceConfig;
}

/** The provider config with its token provider and notification verifier resolved to the host's or the built-in ones. */
interface ResolvedAppleProviderConfig extends AppleProviderConfig {
  /** The configured bundle IDs, `bundleId` first, without duplicates; empty when none is configured. */
  bundleIds: readonly string[];
  /** Returns a token for the bundle, or the host's bundle-less token when no bundle ID is configured. */
  tokenFor: (bundleId: string | undefined) => Promise<string>;
  verifyNotification?: (context: AppleNotificationVerifierContext) => Promise<Record<string, unknown>>;
}

interface AppleTransactionExpectation {
  /** Null when any product is accepted; BillFn checks an imported subscription's product against the plan. */
  productId: string | null;
  reference: string;
  /** Null for a subscription an operator imported: its binding is the operator's, not the purchase token's. */
  appAccountToken: string | null;
}

export function createAppleProvider(providerConfig: AppleProviderConfig): BillFnProviderAdapter {
  const config = resolveAppleProviderConfig(providerConfig);
  const fetchImpl = config.fetch ?? fetch;

  return {
    provider: 'apple',
    capabilities: {
      createCheckout: true,
      verifyCheckout: true,
      cancelSubscription: true,
      syncSubscription: true,
      restorePurchases: true,
      webhookIngestion: true,
      changeSubscription: true,
      resumeSubscription: true,
      refundCharge: true,
      notificationHistory: Boolean(config.verifyNotification),
      importSubscription: true
    },
    async createCheckout(input: BillFnCreateCheckoutInput) {
      const appAccountToken = createAppleAppAccountToken(input.billingAccount.id);
      return {
        status: 'requires_action',
        clientAction: {
          type: 'apple-purchase',
          productId: input.price.providerProductId,
          metadata: { appAccountToken }
        },
        raw: { appAccountToken }
      };
    },
    async verifyCheckout(input: BillFnVerifyCheckoutInput): Promise<BillFnVerifiedBillingState> {
      const transactionId = readString(input.payload ?? {}, ['transactionId', 'originalTransactionId']);
      if (!transactionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Apple verification requires a transactionId or originalTransactionId'
        });
      }

      if (input.price.kind === 'subscription') {
        const response = await requestStoreKitForTransaction(
          fetchImpl,
          config,
          `/inApps/v1/subscriptions/${transactionId}`
        );
        return mapAppleSubscriptionResponse(response.payload, {
          productId: input.price.providerProductId,
          reference: transactionId,
          appAccountToken: createAppleAppAccountToken(input.billingAccount.id)
        });
      }

      const response = await requestStoreKitForTransaction(fetchImpl, config, `/inApps/v2/history/${transactionId}`);
      return mapAppleHistoryResponse(response.payload, {
        productId: input.price.providerProductId,
        reference: transactionId,
        appAccountToken: createAppleAppAccountToken(input.billingAccount.id)
      });
    },
    async fetchSubscription(input: BillFnSyncSubscriptionInput) {
      const transactionId = input.subscription.providerSubscriptionId ?? input.subscription.providerChargeId;
      if (!transactionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Apple subscription sync requires a provider subscription reference'
        });
      }
      const response = await requestStoreKitForTransaction(fetchImpl, config, `/inApps/v1/subscriptions/${transactionId}`);
      // An imported purchase was made outside BillFn, so its token is not derived from the billing account.
      const imported = typeof input.subscription.metadata?.[BILLFN_IMPORTED_AT_METADATA_KEY] === 'string';
      return mapAppleSubscriptionResponse(response.payload, {
        productId: input.price.providerProductId,
        reference: transactionId,
        appAccountToken: imported ? null : createAppleAppAccountToken(input.subscription.billingAccountId)
      });
    },
    async importSubscription(input: BillFnImportSubscriptionInput) {
      let response: Awaited<ReturnType<typeof requestStoreKitForTransaction>>;
      try {
        response = await requestStoreKitForTransaction(
          fetchImpl,
          config,
          `/inApps/v1/subscriptions/${encodeURIComponent(input.providerReference)}`
        );
      } catch (error) {
        return classifyStoreKitImportError(error);
      }
      const transactions = extractLastTransactionRecords(response.payload)
        .map((record) => decodeSignedPayload(record, 'signedTransactionInfo'))
        .filter((transaction): transaction is Record<string, unknown> => transaction !== null);
      if (!transactions.some((transaction) => readString(transaction, ['originalTransactionId']) === input.providerReference)) {
        if (transactions.length === 0) {
          // A success without a readable transaction is not StoreKit's not-found answer: a retry may read it.
          throw createBillFnError({
            code: 'BILLFN_PROVIDER_ERROR',
            message: 'Apple returned no readable transaction for the imported reference'
          });
        }
        // StoreKit found the subscription by another of its transactions; the import binds its original transaction id.
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'The Apple reference is not an original transaction id; import the subscription by its originalTransactionId',
          details: {
            originalTransactionIds: [
              ...new Set(transactions.map((transaction) => readString(transaction, ['originalTransactionId'])).filter(Boolean))
            ]
          }
        });
      }
      // A purchase made outside BillFn carries no BillFn appAccountToken, so only the transaction is matched.
      return mapAppleSubscriptionResponse(response.payload, {
        productId: null,
        reference: input.providerReference,
        appAccountToken: null
      });
    },
    async cancelSubscription(input: BillFnCancelSubscriptionInput) {
      const transactionId = input.subscription.providerChargeId ?? input.subscription.providerSubscriptionId;
      if (!transactionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Apple cancellation requires a transaction reference'
        });
      }
      if (!config.advancedCommerce?.enabled) {
        return manageSubscriptionAction('Apple subscription management is handled by Apple-managed surfaces');
      }
      const response = await requestAdvancedCommerce(
        fetchImpl,
        config,
        transactionId,
        `/subscription/cancel/${transactionId}`,
        {
          method: 'POST'
        }
      );
      return {
        operationStatus: 'applied',
        billingState: {
          subscriptionStatus: 'canceled',
          checkoutStatus: 'succeeded',
          providerSubscriptionId: input.subscription.providerSubscriptionId,
          providerChargeId: input.subscription.providerChargeId,
          currentPeriodStart: input.subscription.currentPeriodStart,
          currentPeriodEnd: input.subscription.currentPeriodEnd,
          autoRenew: false,
          raw: response
        },
        raw: response
      } satisfies BillFnProviderOperationResult;
    },
    async changeSubscription(_input: BillFnChangeSubscriptionInput) {
      return manageSubscriptionAction('Apple plan changes are handled by Apple-managed subscription surfaces');
    },
    async resumeSubscription(_input: BillFnResumeSubscriptionInput) {
      return manageSubscriptionAction('Apple subscription resume is handled by Apple-managed subscription surfaces');
    },
    async refundCharge(input: BillFnRefundChargeInput) {
      const transactionId = input.providerChargeId ?? input.subscription?.providerChargeId ?? input.subscription?.providerSubscriptionId;
      if (!transactionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Apple refund requires a transaction reference'
        });
      }
      if (!config.advancedCommerce?.enabled) {
        return manageSubscriptionAction('Apple refunds require Advanced Commerce or Apple-managed support flows');
      }
      const response = await requestAdvancedCommerce(
        fetchImpl,
        config,
        transactionId,
        `/subscription/revoke/${transactionId}`,
        {
          method: 'POST',
          body: JSON.stringify({
            reason: input.reason
          })
        }
      );
      return {
        operationStatus: 'applied',
        providerRefundId: readString(response, ['requestReferenceId', 'refundId']) ?? undefined,
        billingState: input.subscription
          ? {
              subscriptionStatus: 'canceled',
              checkoutStatus: 'succeeded',
              providerSubscriptionId: input.subscription.providerSubscriptionId,
              providerChargeId: input.subscription.providerChargeId,
              currentPeriodStart: input.subscription.currentPeriodStart,
              currentPeriodEnd: input.subscription.currentPeriodEnd,
              autoRenew: false,
              raw: response
            }
          : undefined,
        raw: response
      } satisfies BillFnProviderOperationResult;
    },
    async restorePurchases(input: BillFnRestorePurchasesInput) {
      const response = await requestStoreKitForTransaction(
        fetchImpl,
        config,
        input.price.kind === 'subscription'
          ? `/inApps/v1/subscriptions/${input.purchaseReference}`
          : `/inApps/v2/history/${input.purchaseReference}`
      );
      const expectation = {
        productId: input.price.providerProductId,
        reference: input.purchaseReference,
        appAccountToken: createAppleAppAccountToken(input.billingAccount.id)
      };
      return [input.price.kind === 'subscription'
        ? mapAppleSubscriptionResponse(response.payload, expectation)
        : mapAppleHistoryResponse(response.payload, expectation)];
    },
    async parseWebhook(input): Promise<BillFnParsedWebhookEvent[]> {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(input.rawBody) as Record<string, unknown>;
      } catch {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Apple webhook payload must be valid JSON'
        });
      }

      const signedPayload = readString(payload, ['signedPayload']);
      if (!signedPayload) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Apple webhook payload must include signedPayload'
        });
      }

      const decoded = await decodeNotificationPayload(config, {
        rawBody: input.rawBody,
        signedPayload
      });

      return [mapAppleNotificationEvent(decoded, signedPayload)];
    },
    async fetchNotificationHistory(input: BillFnFetchNotificationHistoryInput): Promise<BillFnNotificationHistoryPage> {
      if (!config.verifyNotification) {
        throw createBillFnError({
          code: 'BILLFN_FEATURE_UNAVAILABLE',
          message: 'Apple notification history requires bundleId, bundleIds or notificationVerifier'
        });
      }
      // Apple keeps each app's notification history apart, so the apps are read one after another.
      const position = readNotificationHistoryCursor(config.bundleIds, input.cursor);
      const response = await requestStoreKitWithFallback(
        fetchImpl,
        config,
        position.bundleId,
        buildNotificationHistoryPath(position.paginationToken),
        {
          method: 'POST',
          body: JSON.stringify(buildNotificationHistoryRequest())
        }
      );
      const notifications = Array.isArray(response.payload.notificationHistory)
        ? response.payload.notificationHistory
        : Array.isArray(response.payload.signedNotifications)
          ? response.payload.signedNotifications
          : [];

      const events: BillFnParsedWebhookEvent[] = [];
      for (const entry of notifications) {
        const signedPayload = typeof entry === 'string'
          ? entry
          : typeof entry === 'object' && entry !== null && typeof (entry as { signedPayload?: unknown }).signedPayload === 'string'
            ? (entry as { signedPayload: string }).signedPayload
            : null;
        if (!signedPayload) {
          continue;
        }
        const decoded = await decodeNotificationPayload(config, {
          rawBody: JSON.stringify({ signedPayload }),
          signedPayload
        });
        events.push(mapAppleNotificationEvent(decoded, signedPayload));
      }

      return {
        events,
        nextCursor: buildNextNotificationHistoryCursor(
          config.bundleIds,
          position.bundleId,
          readString(response.payload, ['paginationToken', 'nextPaginationToken']) ?? undefined
        )
      };
    }
  };
}

/**
 * Requests a transaction's StoreKit record. With several bundle IDs the transaction's app is not known up front, so
 * each app is asked in order, with a token claiming it as `bid`, until StoreKit's answer is not its definitive
 * not-found: Apple answers only for transactions of the app the token names.
 */
async function requestStoreKitForTransaction(
  fetchImpl: typeof fetch,
  config: ResolvedAppleProviderConfig,
  path: string,
  init: RequestInit = {}
) {
  const bundleIds = config.bundleIds.length > 0 ? config.bundleIds : [undefined];
  let lastError: unknown;
  for (const bundleId of bundleIds) {
    try {
      return await requestStoreKitWithFallback(fetchImpl, config, bundleId, path, init);
    } catch (error) {
      lastError = error;
      if (!isStoreKitNotFound(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

/** True for StoreKit's definitive answer that the transaction does not exist for the app the token names. */
function isStoreKitNotFound(error: unknown): boolean {
  const details = (error as { details?: { status?: unknown; body?: unknown } } | null)?.details;
  const errorCode = readStoreKitErrorCode(details?.body);
  return details?.status === 404 && errorCode !== undefined && STOREKIT_NOT_FOUND_ERROR_CODES.has(errorCode);
}

async function requestStoreKitWithFallback(
  fetchImpl: typeof fetch,
  config: ResolvedAppleProviderConfig,
  bundleId: string | undefined,
  path: string,
  init: RequestInit = {}
) {
  const initial = config.environment ?? 'production';
  const environments: Array<'production' | 'sandbox'> = initial === 'production' ? ['production', 'sandbox'] : ['sandbox'];
  let lastError: unknown;

  for (const environment of environments) {
    try {
      const payload = await requestJson(fetchImpl, buildStoreKitBaseUrl(environment) + path, await config.tokenFor(bundleId), init);
      return {
        environment,
        bundleId,
        payload
      };
    } catch (error) {
      lastError = error;
      if (!shouldFallbackToSandbox(error, environment)) {
        throw error;
      }
    }
  }

  throw lastError;
}

/**
 * Sends an Advanced Commerce request about a transaction, with a token for the transaction's app. With several bundle
 * IDs that app is first found by reading the transaction from StoreKit, app by app.
 */
async function requestAdvancedCommerce(
  fetchImpl: typeof fetch,
  config: ResolvedAppleProviderConfig,
  transactionId: string,
  path: string,
  init: RequestInit
) {
  const advancedCommerce = config.advancedCommerce ?? {};
  const bundleId = config.bundleIds.length > 1
    ? (await requestStoreKitForTransaction(fetchImpl, config, `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`))
        .bundleId
    : config.bundleIds[0];
  const hostTokenProvider = advancedCommerce.tokenProvider;
  const token = hostTokenProvider
    ? await (bundleId === undefined ? hostTokenProvider() : hostTokenProvider({ bundleId }))
    : await config.tokenFor(bundleId);
  const baseUrl = (advancedCommerce.baseUrl ?? 'https://api.storekit.itunes.apple.com/advancedCommerce/v1').replace(/\/$/, '');
  const response = await fetchImpl(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const raw = await response.text();
  if (!response.ok) {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: `Apple Advanced Commerce request failed with status ${response.status}`,
      details: {
        status: response.status,
        body: raw
      }
    });
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function requestJson(fetchImpl: typeof fetch, url: string, token: string, init: RequestInit = {}) {
  const response = await fetchImpl(url, {
    ...init,
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const raw = await response.text();
  if (!response.ok) {
    throw createProviderError(response.status, raw);
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function createProviderError(status: number, body: string) {
  return createBillFnError({
    code: 'BILLFN_PROVIDER_ERROR',
    message: `Apple request failed with status ${status}`,
    details: {
      status,
      body
    }
  });
}

function buildStoreKitBaseUrl(environment: 'production' | 'sandbox') {
  return environment === 'production'
    ? 'https://api.storekit.itunes.apple.com'
    : 'https://api.storekit-sandbox.itunes.apple.com';
}

/** StoreKit's definitive answers that a transaction does not exist (TransactionIdNotFound, OriginalTransactionIdNotFound). */
const STOREKIT_NOT_FOUND_ERROR_CODES = new Set([4040010, 4040005]);
/** StoreKit's rejections of a malformed reference (InvalidTransactionId, InvalidOriginalTransactionId). */
const STOREKIT_INVALID_REFERENCE_ERROR_CODES = new Set([4000006, 4000008]);

/**
 * Classifies a failed import read by StoreKit's errorCode, not its HTTP status: only a definitive not-found answer
 * (after the sandbox fallback for 4040010) is missing, a malformed reference is invalid input, and anything else,
 * including StoreKit's retryable 404s (4040002, 4040004, 4040006), an unparsable body and a request that got no answer,
 * stays a retryable provider error.
 */
function classifyStoreKitImportError(error: unknown): null {
  if (error instanceof SyntaxError) {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Apple returned an unreadable response for the imported reference'
    });
  }
  if (isStoreKitNotFound(error)) {
    return null;
  }
  const details = (error as { details?: { status?: unknown; body?: unknown } } | null)?.details;
  const errorCode = readStoreKitErrorCode(details?.body);
  if (details?.status === 400 && errorCode !== undefined && STOREKIT_INVALID_REFERENCE_ERROR_CODES.has(errorCode)) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'Apple rejected the imported reference as malformed',
      details: { status: details.status, errorCode }
    });
  }
  if (isBillFnError(error)) {
    throw error;
  }
  // No answer from StoreKit (the request or its body read failed, or its token was not issued): a retry may read it.
  // The raw error stays out of the message, which reaches the operator.
  throw createBillFnError({
    code: 'BILLFN_PROVIDER_ERROR',
    message: 'Apple could not be reached to read the imported reference'
  });
}

function isBillFnError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('BILLFN_');
}

function readStoreKitErrorCode(body: unknown): number | undefined {
  if (typeof body !== 'string') {
    return undefined;
  }
  try {
    const errorCode = (JSON.parse(body) as { errorCode?: unknown } | null)?.errorCode;
    return typeof errorCode === 'number' ? errorCode : undefined;
  } catch {
    return undefined;
  }
}

function shouldFallbackToSandbox(error: unknown, environment: 'production' | 'sandbox') {
  if (environment !== 'production') {
    return false;
  }
  if (!error || typeof error !== 'object' || !('details' in error)) {
    return false;
  }
  const details = (error as { details?: { status?: unknown; body?: unknown } }).details;
  if (details?.status !== 404 || typeof details.body !== 'string') {
    return false;
  }
  try {
    const payload = JSON.parse(details.body) as { errorCode?: unknown };
    return payload.errorCode === 4040010;
  } catch {
    return false;
  }
}

function resolveAppleProviderConfig(config: AppleProviderConfig): ResolvedAppleProviderConfig {
  const bundleIds = readProviderBundleIds(config);
  const bundleId = bundleIds[0];
  let tokenFor: ResolvedAppleProviderConfig['tokenFor'];
  const hostTokenProvider = config.tokenProvider;
  if (hostTokenProvider) {
    tokenFor = (bundle) => (bundle === undefined ? hostTokenProvider() : hostTokenProvider({ bundleId: bundle }));
  } else if (config.appStoreServerApiKey) {
    if (!bundleId) {
      throw new TypeError('The Apple provider signs App Store Server API tokens only with a bundleId');
    }
    // One signer per app: the team key signs every app's tokens, each claiming its own bundle ID as `bid`.
    const key = config.appStoreServerApiKey;
    const signers = new Map(bundleIds.map((bundle) => [bundle, createAppStoreServerApiTokenSigner({ ...key, bundleId: bundle })]));
    tokenFor = (bundle) => signers.get(bundle ?? bundleId)!();
  } else {
    throw new TypeError('The Apple provider requires tokenProvider, or bundleId with appStoreServerApiKey');
  }
  const hostVerifier = config.notificationVerifier;
  let verifyNotification: ResolvedAppleProviderConfig['verifyNotification'];
  if (hostVerifier) {
    verifyNotification = async (context) => {
      const verified = await hostVerifier(context);
      if (!verified) {
        throw notificationSignatureInvalid();
      }
      return verified;
    };
  } else if (bundleId) {
    verifyNotification = createBuiltInNotificationVerifier(createAppleSignedDataVerifier({ bundleIds }));
  }
  return { ...config, bundleId, bundleIds, tokenFor, verifyNotification };
}

/** Reads `bundleId` and `bundleIds` into one list, `bundleId` first and without duplicates. */
function readProviderBundleIds(config: AppleProviderConfig): string[] {
  const bundleIds: string[] = config.bundleId === undefined ? [] : [requireBundleId(config.bundleId, 'bundleId')];
  if (config.bundleIds !== undefined) {
    if (!Array.isArray(config.bundleIds) || config.bundleIds.length === 0) {
      throw new TypeError('The Apple provider bundleIds must be a non-empty array of bundle IDs');
    }
    for (const entry of config.bundleIds) {
      const bundle = requireBundleId(entry, 'bundleIds entry');
      if (!bundleIds.includes(bundle)) {
        bundleIds.push(bundle);
      }
    }
  }
  return bundleIds;
}

function requireBundleId(bundleId: unknown, field: string): string {
  if (typeof bundleId !== 'string' || bundleId.trim().length === 0) {
    throw new TypeError(`The Apple provider ${field} must be a non-empty string`);
  }
  return bundleId;
}

function createBuiltInNotificationVerifier(verifier: AppleSignedDataVerifier) {
  return async (context: AppleNotificationVerifierContext) => {
    try {
      return (await verifier.verifyNotification(context.signedPayload)).payload;
    } catch (error) {
      if (error instanceof AppleSignedDataVerificationError) {
        throw notificationSignatureInvalid(error.reason);
      }
      throw error;
    }
  };
}

function notificationSignatureInvalid(reason?: string) {
  return createBillFnError({
    code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID',
    message: 'Apple notification signature verification failed',
    ...(reason ? { details: { reason } } : {})
  });
}

async function decodeNotificationPayload(
  config: ResolvedAppleProviderConfig,
  context: AppleNotificationVerifierContext
) {
  if (config.verifyNotification) {
    return {
      payload: await config.verifyNotification(context),
      signatureVerified: true
    };
  }

  const payload = decodeJwtPayload<Record<string, unknown>>(context.signedPayload);
  if (!payload) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'Apple notification signedPayload could not be decoded'
    });
  }

  return {
    payload,
    signatureVerified: false
  };
}

function buildNotificationHistoryPath(cursor?: string) {
  const params = new URLSearchParams();
  if (cursor) {
    params.set('paginationToken', cursor);
  }
  const query = params.toString();
  return query ? `/inApps/v1/notifications/history?${query}` : '/inApps/v1/notifications/history';
}

/**
 * Marks a notification history cursor that names the app it continues. A cursor without it is Apple's own
 * pagination token, which a single-app adapter returns unchanged and a multi-app adapter reads as the first app's.
 */
const NOTIFICATION_HISTORY_CURSOR_PREFIX = 'billfn-apple-history:';

interface NotificationHistoryPosition {
  bundleId: string | undefined;
  paginationToken: string | undefined;
}

function readNotificationHistoryCursor(bundleIds: readonly string[], cursor: string | undefined): NotificationHistoryPosition {
  if (bundleIds.length <= 1 || !cursor?.startsWith(NOTIFICATION_HISTORY_CURSOR_PREFIX)) {
    return { bundleId: bundleIds[0], paginationToken: cursor || undefined };
  }
  const position = parseJsonRecord(Buffer.from(cursor.slice(NOTIFICATION_HISTORY_CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  const bundleId = position?.bundleId;
  const paginationToken = position?.paginationToken;
  if (
    typeof bundleId !== 'string' ||
    !bundleIds.includes(bundleId) ||
    (paginationToken !== undefined && (typeof paginationToken !== 'string' || paginationToken.length === 0))
  ) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'The Apple notification history cursor does not name a configured bundle ID'
    });
  }
  return { bundleId, paginationToken };
}

/** Continues the app's history while Apple has more, then starts the next app's; undefined after the last app. */
function buildNextNotificationHistoryCursor(
  bundleIds: readonly string[],
  bundleId: string | undefined,
  paginationToken: string | undefined
): string | undefined {
  if (bundleIds.length <= 1) {
    return paginationToken;
  }
  const nextBundleId = bundleIds[bundleIds.indexOf(bundleId as string) + 1];
  const next = paginationToken ? { bundleId, paginationToken } : nextBundleId === undefined ? undefined : { bundleId: nextBundleId };
  return next && NOTIFICATION_HISTORY_CURSOR_PREFIX + Buffer.from(JSON.stringify(next), 'utf8').toString('base64url');
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function buildNotificationHistoryRequest() {
  const endDate = Date.now();
  return {
    startDate: endDate - 24 * 60 * 60 * 1000,
    endDate
  };
}

function mapAppleNotificationEvent(
  decoded: {
    payload: Record<string, unknown>;
    signatureVerified: boolean;
  },
  signedPayload: string
): BillFnParsedWebhookEvent {
  const notification = decoded.payload;
  const data = asRecord(notification.data) ?? {};
  const transaction = decodeSignedPayload(data, 'signedTransactionInfo');
  const renewal = decodeSignedPayload(data, 'signedRenewalInfo');
  const notificationType = readString(notification, ['notificationType']) ?? 'UNKNOWN';
  const subtype = readString(notification, ['subtype']) ?? undefined;
  const state = mapAppleNotificationState(notificationType, subtype, transaction, renewal);

  return {
    providerEventId: readString(notification, ['notificationUUID']) ?? readString(notification, ['notificationId']) ?? signedPayload,
    type: subtype ? `${notificationType}.${subtype}` : notificationType,
    signatureVerified: decoded.signatureVerified,
    occurredAt: millisToIso(readTimestamp(notification, ['signedDate'])) ?? undefined,
    providerSubscriptionId: readString(transaction ?? {}, ['originalTransactionId']) ?? undefined,
    providerChargeId: readString(transaction ?? {}, ['transactionId']) ?? undefined,
    priceId: readString(transaction ?? {}, ['productId']) ?? undefined,
    billingState: state,
    raw: notification
  };
}

function mapAppleNotificationState(
  notificationType: string,
  subtype: string | undefined,
  transaction: Record<string, unknown> | null,
  renewal: Record<string, unknown> | null
): BillFnVerifiedBillingState | undefined {
  if (notificationType === 'TEST') {
    return undefined;
  }

  const transactionState = mapTransactionPayload(transaction, renewal);
  if (!transactionState) {
    return undefined;
  }

  switch (notificationType) {
    case 'SUBSCRIBED':
    case 'DID_RENEW':
      return {
        ...transactionState,
        subscriptionStatus: 'active',
        checkoutStatus: 'succeeded'
      };
    case 'DID_FAIL_TO_RENEW':
      return {
        ...transactionState,
        subscriptionStatus: subtype === 'GRACE_PERIOD' ? 'grace' : 'past_due',
        checkoutStatus: 'succeeded'
      };
    case 'EXPIRED':
      return {
        ...transactionState,
        subscriptionStatus: 'expired',
        checkoutStatus: 'failed',
        autoRenew: false
      };
    case 'REFUND':
    case 'REFUND_DECLINED_RENEWAL':
    case 'REVOKE':
    case 'CANCEL':
      return {
        ...transactionState,
        subscriptionStatus: 'canceled',
        checkoutStatus: 'succeeded',
        autoRenew: false
      };
    case 'DID_CHANGE_RENEWAL_STATUS':
      return {
        ...transactionState,
        subscriptionStatus: 'active',
        checkoutStatus: 'succeeded',
        autoRenew: subtype === 'AUTO_RENEW_DISABLED' ? false : transactionState.autoRenew
      };
    case 'DID_CHANGE_RENEWAL_PREF':
      return {
        ...transactionState,
        subscriptionStatus: 'active',
        checkoutStatus: 'succeeded'
      };
    default:
      return transactionState;
  }
}

function mapAppleSubscriptionResponse(
  payload: Record<string, unknown>,
  expectation: AppleTransactionExpectation
): BillFnVerifiedBillingState {
  const { record: lastTransaction, transaction } = selectAppleLastTransaction(payload, expectation);
  const renewalInfo = decodeSignedPayload(lastTransaction, 'signedRenewalInfo');
  const statusCode = readNumber(lastTransaction ?? {}, ['status']) ?? readNumber(transaction, ['status']) ?? 1;
  const subscriptionStatus = normalizeAppleStatus(statusCode);
  return {
    subscriptionStatus,
    checkoutStatus: subscriptionStatus === 'failed' || subscriptionStatus === 'expired' ? 'failed' : 'succeeded',
    providerSubscriptionId: readString(transaction ?? {}, ['originalTransactionId']) ?? undefined,
    providerChargeId: readString(transaction ?? {}, ['transactionId']) ?? undefined,
    // The product is only inside the signed transaction, which BillFn core does not decode.
    providerProductId: readString(transaction ?? {}, ['productId']) ?? undefined,
    currentPeriodStart: millisToIso(readTimestamp(transaction, ['purchaseDate'])) ?? undefined,
    currentPeriodEnd: millisToIso(readTimestamp(transaction, ['expiresDate'])) ?? undefined,
    autoRenew: readNumber(renewalInfo, ['autoRenewStatus']) === 1,
    raw: payload
  };
}

function mapAppleHistoryResponse(
  payload: Record<string, unknown>,
  expectation: AppleTransactionExpectation
): BillFnVerifiedBillingState {
  const transactions = extractHistoryTransactions(payload);
  const transaction = selectAppleTransaction(transactions, expectation, 'history');
  const expiresAt = millisToIso(readTimestamp(transaction, ['expiresDate'])) ?? undefined;
  const revokedAt = millisToIso(readTimestamp(transaction, ['revocationDate'])) ?? undefined;
  const isExpired = Boolean(expiresAt && new Date(expiresAt).getTime() < Date.now());
  const subscriptionStatus = revokedAt ? 'canceled' : isExpired ? 'expired' : 'active';
  return {
    subscriptionStatus,
    checkoutStatus: subscriptionStatus === 'expired' ? 'failed' : 'succeeded',
    providerSubscriptionId: readString(transaction, ['originalTransactionId']) ?? undefined,
    providerChargeId: readString(transaction, ['transactionId']) ?? undefined,
    providerProductId: readString(transaction, ['productId']) ?? undefined,
    currentPeriodStart: millisToIso(readTimestamp(transaction, ['purchaseDate'])) ?? undefined,
    currentPeriodEnd: expiresAt,
    autoRenew: false,
    raw: payload
  };
}

function mapTransactionPayload(
  transaction: Record<string, unknown> | null,
  renewal: Record<string, unknown> | null
): BillFnVerifiedBillingState | undefined {
  if (!transaction) {
    return undefined;
  }
  const statusCode = readNumber(transaction, ['status']) ?? 1;
  return {
    subscriptionStatus: normalizeAppleStatus(statusCode),
    checkoutStatus: statusCode === 2 ? 'failed' : 'succeeded',
    providerSubscriptionId: readString(transaction, ['originalTransactionId']) ?? undefined,
    providerChargeId: readString(transaction, ['transactionId']) ?? undefined,
    providerProductId: readString(transaction, ['productId']) ?? undefined,
    currentPeriodStart: millisToIso(readTimestamp(transaction, ['purchaseDate'])) ?? undefined,
    currentPeriodEnd: millisToIso(readTimestamp(transaction, ['expiresDate'])) ?? undefined,
    autoRenew: readNumber(renewal, ['autoRenewStatus']) === 1,
    raw: {
      transaction,
      renewal
    }
  };
}

function extractLastTransactionRecords(payload: Record<string, unknown>) {
  const groups = Array.isArray(payload.data) ? payload.data : [];
  return groups.flatMap((group) => asArrayOfRecords(asRecord(group)?.lastTransactions));
}

function selectAppleLastTransaction(
  payload: Record<string, unknown>,
  expectation: AppleTransactionExpectation
) {
  const candidates = extractLastTransactionRecords(payload)
    .map((record) => ({ record, transaction: decodeSignedPayload(record, 'signedTransactionInfo') }))
    .filter((candidate): candidate is { record: Record<string, unknown>; transaction: Record<string, unknown> } =>
      candidate.transaction !== null
    );
  if (candidates.length === 0) {
    throw createBillFnError({
      code: 'BILLFN_NOT_FOUND',
      message: 'Apple subscription response did not contain any transactions'
    });
  }
  const match = candidates.find((candidate) => appleTransactionMatches(candidate.transaction, expectation));
  if (!match) {
    throwAppleTransactionConflict();
  }
  return match;
}

function selectAppleTransaction(
  transactions: Record<string, unknown>[],
  expectation: AppleTransactionExpectation,
  responseKind: string
) {
  if (transactions.length === 0) {
    throw createBillFnError({
      code: 'BILLFN_NOT_FOUND',
      message: `Apple ${responseKind} response did not contain any transactions`
    });
  }
  const match = transactions.find((transaction) => appleTransactionMatches(transaction, expectation));
  if (!match) {
    throwAppleTransactionConflict();
  }
  return match;
}

function appleTransactionMatches(
  transaction: Record<string, unknown>,
  expectation: AppleTransactionExpectation
) {
  const transactionId = readString(transaction, ['transactionId']);
  const originalTransactionId = readString(transaction, ['originalTransactionId']);
  const productId = readString(transaction, ['productId']);
  const appAccountToken = readString(transaction, ['appAccountToken']);
  return (
    (expectation.productId === null || productId === expectation.productId) &&
    (expectation.appAccountToken === null ||
      appAccountToken?.toLowerCase() === expectation.appAccountToken.toLowerCase()) &&
    (transactionId === expectation.reference || originalTransactionId === expectation.reference)
  );
}

function throwAppleTransactionConflict(): never {
  throw createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: 'Apple transaction does not match the checkout product, reference, and billing account token'
  });
}

function extractHistoryTransactions(payload: Record<string, unknown>) {
  const signedTransactions = Array.isArray(payload.signedTransactions) ? payload.signedTransactions : [];
  return signedTransactions
    .map((entry) => (typeof entry === 'string' ? decodeJwtPayload<Record<string, unknown>>(entry) : null))
    .filter(Boolean) as Record<string, unknown>[];
}

function decodeSignedPayload(record: Record<string, unknown>, key: string) {
  const token = record[key];
  return typeof token === 'string' ? decodeJwtPayload<Record<string, unknown>>(token) : null;
}

function decodeJwtPayload<T extends Record<string, unknown>>(token: string): T | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const base = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base.padEnd(Math.ceil(base.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function manageSubscriptionAction(message: string): BillFnProviderOperationResult {
  return {
    operationStatus: 'requires_action',
    clientAction: {
      type: 'manage-subscription',
      metadata: {
        provider: 'apple'
      }
    },
    raw: {
      message
    }
  };
}

function normalizeAppleStatus(statusCode: number): BillFnVerifiedBillingState['subscriptionStatus'] {
  switch (statusCode) {
    case 1:
      return 'active';
    case 2:
      return 'expired';
    case 3:
    case 4:
      return 'grace';
    case 5:
      return 'canceled';
    default:
      return 'failed';
  }
}

function createAppleAppAccountToken(billingAccountId: string) {
  const bytes = createHash('sha256')
    .update(`billfn:apple:${billingAccountId}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20)
  ].join('-');
}

function millisToIso(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return new Date(numeric).toISOString();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function readTimestamp(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function readNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asArrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : [];
}
