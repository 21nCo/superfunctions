import { createHash } from 'node:crypto';
import type {
  BillFnCatalog,
  BillFnCancelSubscriptionInput,
  BillFnChangeSubscriptionInput,
  BillFnCreateCheckoutInput,
  BillFnFetchNotificationHistoryInput,
  BillFnImportSubscriptionInput,
  BillFnNotificationHistoryPage,
  BillFnParsedWebhookEvent,
  BillFnPriceDefinition,
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
import { base64UrlToBytes, utf8ToBase64Url } from './encoding.js';
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

/**
 * The catalog price metadata key naming the app (bundle ID) a price is sold in. Apple product IDs are unique only within
 * an app, so with several bundle IDs every Apple price must name one of them, and only that app's transactions satisfy
 * the price.
 */
export const APPLE_BUNDLE_ID_METADATA_KEY = 'appleBundleId';

/** How long one Apple HTTP call, including its response body, may take before the deadline fails it. */
export const APPLE_PROVIDER_HTTP_DEADLINE_MS = 30_000;

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
   * With `environment: 'production'` (the default), whether sandbox purchases count: StoreKit reads retry against
   * the sandbox when production does not know a transaction, and notifications from the sandbox are applied.
   * Off by default, because a sandbox or TestFlight purchase costs nothing. Turn it on only where it is needed,
   * such as a build under App Review, which buys in the sandbox against the production server.
   */
  allowSandbox?: boolean;
  /**
   * The app's bundle ID. With it the built-in verifier checks notifications (x5c chain to the pinned Apple Root CA - G3,
   * Apple's OIDs, ES256 signature, certificate validity, bundle ID). Signed data is accepted for this app or any app in
   * `bundleIds`, and rejected for any other app. The built-in signer claims, as `bid`, the app being asked about,
   * trying this bundle ID first.
   */
  bundleId?: string;
  /**
   * The bundle IDs of several apps of one developer team, served by this one adapter (with `bundleId`, if also given).
   * The built-in verifier accepts signed data for any listed app and rejects every other app. App Store Server API
   * requests about a transaction are tried for each listed app in order until one is not StoreKit's not-found answer,
   * so each request's token claims, as `bid`, the app being asked.
   */
  bundleIds?: readonly string[];
  /**
   * The BillFn catalog (the one given to BillFn). With several bundle IDs every Apple price in it must name its app as
   * `metadata.appleBundleId`, which `createAppleProvider` checks. A product ID that the apps sell in more than one plan
   * is then resolved by the app that signed the transaction: webhook and notification history events (`priceId`) and
   * read billing states (`raw.priceId`) name the catalog price of that app, so BillFn applies that app's plan. Without
   * it, BillFn matches such a product by product ID alone and keeps the stored plan.
   */
  catalog?: BillFnCatalog;
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
  /** The catalog price ID a signed transaction names, when its product needs its app to name one (`catalog`). */
  catalogPriceIdFor: CatalogPriceIdResolver;
}

/** Returns the catalog price ID for a signed transaction, preferring `currentPriceId` among its app's prices. */
type CatalogPriceIdResolver = (transaction: Record<string, unknown> | null, currentPriceId?: string) => string | undefined;

interface AppleTransactionExpectation {
  /** Null when any product is accepted; BillFn checks an imported subscription's product against the plan. */
  productId: string | null;
  reference: string;
  /** Null for a subscription an operator imported: its binding is the operator's, not the purchase token's. */
  appAccountToken: string | null;
  /** The app the price is sold in, which the signed transaction must name; null when the price names none. */
  bundleId: string | null;
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
      readPriceBundleId(config, input.price);
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

      const bundleId = readPriceBundleId(config, input.price);
      const expectation = {
        productId: input.price.providerProductId,
        reference: transactionId,
        appAccountToken: createAppleAppAccountToken(input.billingAccount.id),
        bundleId
      };
      if (input.price.kind === 'subscription') {
        const response = await requestStoreKitForPrice(fetchImpl, config, bundleId, `/inApps/v1/subscriptions/${encodeStoreKitPathSegment(transactionId)}`);
        return mapAppleSubscriptionResponse(response.payload, expectation, config.catalogPriceIdFor, input.price.priceId);
      }

      const response = await requestStoreKitForPrice(fetchImpl, config, bundleId, `/inApps/v2/history/${encodeStoreKitPathSegment(transactionId)}`);
      return mapAppleHistoryResponse(response.payload, expectation, config.catalogPriceIdFor, input.price.priceId);
    },
    async fetchSubscription(input: BillFnSyncSubscriptionInput) {
      const transactionId = input.subscription.providerSubscriptionId ?? input.subscription.providerChargeId;
      if (!transactionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Apple subscription sync requires a provider subscription reference'
        });
      }
      // Sync reads a stored subscription whose reference verification, restore or an operator's import already bound to
      // its app, so it grants no new price. BillFn picks the price it passes by product alone, which with several apps may
      // be another app's price of the same product, so the subscription is read from whichever listed app owns it.
      // A deployment that no longer accepts the sandbox still reads it here, in the same order as before, so a
      // subscription accepted from the sandbox earlier is found and can end; what the sandbox reports never grants
      // access (see below).
      const response = await requestStoreKitForTransaction(
        fetchImpl,
        config,
        `/inApps/v1/subscriptions/${encodeStoreKitPathSegment(transactionId)}`,
        {},
        { sandboxForRevocation: true }
      );
      // An imported purchase was made outside BillFn, so its token is not derived from the billing account.
      const imported = typeof input.subscription.metadata?.[BILLFN_IMPORTED_AT_METADATA_KEY] === 'string';
      const state = mapAppleSubscriptionResponse(response.payload, {
        productId: input.price.providerProductId,
        reference: transactionId,
        appAccountToken: imported ? null : createAppleAppAccountToken(input.subscription.billingAccountId),
        bundleId: null
      }, config.catalogPriceIdFor, input.price.priceId);
      if (response.environment === 'sandbox' && !acceptsSandbox(config)) {
        // A sandbox subscription has no access in this deployment: it is expired unless it already ended.
        return TERMINAL_APPLE_STATES.has(state.subscriptionStatus)
          ? { ...state, autoRenew: false }
          : { ...state, subscriptionStatus: 'expired', checkoutStatus: 'failed', autoRenew: false };
      }
      return state;
    },
    async importSubscription(input: BillFnImportSubscriptionInput) {
      let response: Awaited<ReturnType<typeof requestStoreKitForTransaction>>;
      try {
        response = await requestStoreKitForTransaction(
          fetchImpl,
          config,
          `/inApps/v1/subscriptions/${encodeStoreKitPathSegment(input.providerReference)}`
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
        appAccountToken: null,
        bundleId: null
      }, config.catalogPriceIdFor);
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
      const { data, bodyTimedOut } = await requestAdvancedCommerce(
        fetchImpl,
        config,
        transactionId,
        'cancel',
        {
          method: 'POST'
        }
      );
      if (bodyTimedOut) {
        // The 200 confirms cancellation. Let StoreKit sync or a notification supply the state, since the
        // response body is missing and writing the pre-request snapshot could overwrite a newer event.
        return { operationStatus: 'applied', raw: data } satisfies BillFnProviderOperationResult;
      }
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
          raw: data
        },
        raw: data
      } satisfies BillFnProviderOperationResult;
    },
    async changeSubscription(_input: BillFnChangeSubscriptionInput) {
      return manageSubscriptionAction('Apple plan changes are handled by Apple-managed subscription surfaces');
    },
    async resumeSubscription(_input: BillFnResumeSubscriptionInput) {
      return manageSubscriptionAction('Apple subscription resume is handled by Apple-managed subscription surfaces');
    },
    async refundCharge(input: BillFnRefundChargeInput) {
      // Apple refunds or revokes a whole transaction; it has no partial refund, so a partial request is
      // refused before anything reaches Apple rather than sent as a revoke.
      if ((input.mode !== undefined && input.mode !== 'full') || input.amount !== undefined) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Apple supports only full refunds, without an amount'
        });
      }
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
      const { data: response } = await requestAdvancedCommerce(
        fetchImpl,
        config,
        transactionId,
        'revoke',
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
      const bundleId = readPriceBundleId(config, input.price);
      const response = await requestStoreKitForPrice(
        fetchImpl,
        config,
        bundleId,
        input.price.kind === 'subscription'
          ? `/inApps/v1/subscriptions/${encodeStoreKitPathSegment(input.purchaseReference)}`
          : `/inApps/v2/history/${encodeStoreKitPathSegment(input.purchaseReference)}`
      );
      const expectation = {
        productId: input.price.providerProductId,
        reference: input.purchaseReference,
        appAccountToken: createAppleAppAccountToken(input.billingAccount.id),
        bundleId
      };
      return [input.price.kind === 'subscription'
        ? mapAppleSubscriptionResponse(response.payload, expectation, config.catalogPriceIdFor, input.price.priceId)
        : mapAppleHistoryResponse(response.payload, expectation, config.catalogPriceIdFor, input.price.priceId)];
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

      return [mapAppleNotificationEvent(decoded, signedPayload, config.catalogPriceIdFor, acceptsSandbox(config))];
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
        events.push(mapAppleNotificationEvent(decoded, signedPayload, config.catalogPriceIdFor, acceptsSandbox(config)));
      }

      return {
        events,
        nextCursor: buildNextNotificationHistoryCursor(
          config.bundleIds,
          position.bundleId,
          readString(response.payload, ['paginationToken', 'nextPaginationToken']) ?? undefined,
          typeof response.payload.hasMore === 'boolean' ? response.payload.hasMore : undefined
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
  init: RequestInit = {},
  options: StoreKitReadOptions = {}
) {
  const bundleIds = config.bundleIds.length > 0 ? config.bundleIds : [undefined];
  let lastError: unknown;
  for (const bundleId of bundleIds) {
    try {
      return await requestStoreKitWithFallback(fetchImpl, config, bundleId, path, init, options);
    } catch (error) {
      lastError = error;
      if (!isStoreKitNotFound(error)) {
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * Requests a transaction's StoreKit record for a catalog price. A price bound to an app is asked about only with a token
 * for that app, so another app's transaction is StoreKit's not-found; an unbound price keeps the per-app search.
 */
function requestStoreKitForPrice(
  fetchImpl: typeof fetch,
  config: ResolvedAppleProviderConfig,
  bundleId: string | null,
  path: string
) {
  return bundleId === null
    ? requestStoreKitForTransaction(fetchImpl, config, path)
    : requestStoreKitWithFallback(fetchImpl, config, bundleId, path);
}

/**
 * The app a catalog price is sold in, from its trusted `metadata.appleBundleId`, never from client input. With several
 * bundle IDs a price must name one of them; with one it may, and must then name that one; with none it is not read.
 */
function readPriceBundleId(config: ResolvedAppleProviderConfig, price: BillFnPriceDefinition): string | null {
  const value = price.metadata?.[APPLE_BUNDLE_ID_METADATA_KEY];
  if (config.bundleIds.length === 0 || (value === undefined && config.bundleIds.length === 1)) {
    return null;
  }
  if (typeof value !== 'string' || !config.bundleIds.includes(value)) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: `Apple price ${price.priceId} must name the app it is sold in as metadata.${APPLE_BUNDLE_ID_METADATA_KEY}, one of the configured bundle IDs`,
      details: { priceId: price.priceId, bundleIds: [...config.bundleIds] }
    });
  }
  return value;
}

/** True for StoreKit's definitive answer that the transaction does not exist for the app the token names. */
function isStoreKitNotFound(error: unknown): boolean {
  const details = (error as { details?: { status?: unknown; body?: unknown } } | null)?.details;
  const errorCode = readStoreKitErrorCode(details?.body);
  return details?.status === 404 && errorCode !== undefined && STOREKIT_NOT_FOUND_ERROR_CODES.has(errorCode);
}

interface StoreKitReadOptions {
  /**
   * Read the sandbox after production's "transaction not found" even when sandbox purchases are not accepted. The
   * caller must use a sandbox answer (`environment: 'sandbox'` in the result) only to end access, never to grant it.
   */
  sandboxForRevocation?: boolean;
}

async function requestStoreKitWithFallback(
  fetchImpl: typeof fetch,
  config: ResolvedAppleProviderConfig,
  bundleId: string | undefined,
  path: string,
  init: RequestInit = {},
  options: StoreKitReadOptions = {}
) {
  const initial = config.environment ?? 'production';
  // Production falls back to the sandbox only when the host allows sandbox purchases, or for a read whose caller
  // uses a sandbox answer only to end access (`sandboxForRevocation`).
  const fallback = config.allowSandbox === true || options.sandboxForRevocation === true;
  const environments: Array<'production' | 'sandbox'> =
    initial === 'production' ? (fallback ? ['production', 'sandbox'] : ['production']) : ['sandbox'];
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
      if (environment === 'sandbox' && initial === 'production' && config.allowSandbox !== true) {
        // A sandbox read only for revocation never decides the lookup: whatever it answers, production's
        // "not found" stands, so the search goes on to the next app as a production-only read would.
        throw lastError;
      }
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
  operation: 'cancel' | 'revoke',
  init: RequestInit
) {
  const transactionPath = encodeStoreKitPathSegment(transactionId);
  const advancedCommerce = config.advancedCommerce ?? {};
  const bundleId = config.bundleIds.length > 1
    ? (await requestStoreKitForTransaction(fetchImpl, config, `/inApps/v1/transactions/${transactionPath}`))
        .bundleId
    : config.bundleIds[0];
  const hostTokenProvider = advancedCommerce.tokenProvider;
  const token = hostTokenProvider
    ? await (bundleId === undefined ? hostTokenProvider() : hostTokenProvider({ bundleId }))
    : await config.tokenFor(bundleId);
  const baseUrl = (advancedCommerce.baseUrl ?? 'https://api.storekit.itunes.apple.com/advancedCommerce/v1').replace(/\/$/, '');
  const { response, raw, bodyTimedOut } = await fetchProviderText(
    fetchImpl,
    `${baseUrl}/subscription/${operation}/${transactionPath}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {})
      }
    },
    operation
  );
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
  return { data: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, bodyTimedOut };
}

async function requestJson(fetchImpl: typeof fetch, url: string, token: string, init: RequestInit = {}) {
  const { response, raw } = await fetchProviderText(
    fetchImpl,
    url,
    {
      ...init,
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {})
      }
    },
    'read'
  );
  if (!response.ok) {
    throw createProviderError(response.status, raw);
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

/** Fetches one Apple response and reads its body, under one deadline for both. */
async function fetchProviderText(
  fetchImpl: typeof fetch,
  url: string,
  init: Omit<RequestInit, 'signal'>,
  kind: 'read' | 'cancel' | 'revoke'
): Promise<{ response: Response; raw: string; bodyTimedOut?: true }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Apple HTTP deadline');
      reject(error);
      controller.abort(error);
    }, APPLE_PROVIDER_HTTP_DEADLINE_MS);
  });
  let response: Response | undefined;
  try {
    const request = async () => {
      const fetched = await fetchImpl(url, { ...init, signal: controller.signal });
      controller.signal.throwIfAborted();
      response = fetched;
      return { response: fetched, raw: await fetched.text() };
    };
    return await Promise.race([request(), expired]);
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
    if (kind !== 'read' && response && !response.ok) {
      return { response, raw: '' };
    }
    // Apple documents HTTP 200 from the cancellation endpoint as confirmation that auto-renew is off.
    // https://developer.apple.com/documentation/advancedcommerceapi/cancel-a-subscription
    if (kind === 'cancel' && response?.status === 200) {
      return { response, raw: '', bodyTimedOut: true };
    }
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: kind === 'read'
        ? 'Apple did not answer before the deadline; the read can be retried'
        : 'Apple did not answer before the deadline; whether the change was applied is unknown',
      retryable: kind === 'read'
    });
  } finally {
    clearTimeout(timer);
  }
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

/** One URL path segment for a transaction or purchase reference; a reference that cannot be encoded is invalid input. */
function encodeStoreKitPathSegment(reference: string): string {
  // A dot-only segment stays as it is when encoded, and URL parsing would resolve it out of the path.
  if (/^\.+$/.test(reference)) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'Apple transaction reference is not a valid string'
    });
  }
  try {
    return encodeURIComponent(reference);
  } catch {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'Apple transaction reference is not a valid string'
    });
  }
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
      throw new TypeError('The Apple provider signs App Store Server API tokens only with a bundleId or bundleIds');
    }
    // One signer per app: the team key signs every app's tokens, each claiming its own bundle ID as `bid`.
    const key = config.appStoreServerApiKey;
    const signers = new Map(bundleIds.map((bundle) => [bundle, createAppStoreServerApiTokenSigner({ ...key, bundleId: bundle })]));
    tokenFor = (bundle) => signers.get(bundle ?? bundleId)!();
  } else {
    throw new TypeError('The Apple provider requires tokenProvider, or bundleId with appStoreServerApiKey (or bundleIds in place of bundleId)');
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
  const resolved: ResolvedAppleProviderConfig = {
    ...config,
    bundleId,
    bundleIds,
    tokenFor,
    verifyNotification,
    catalogPriceIdFor: () => undefined
  };
  resolved.catalogPriceIdFor = createCatalogPriceIdResolver(resolved, config.catalog);
  return resolved;
}

/**
 * With several bundle IDs and a catalog, resolves a product the listed apps sell in more than one plan by the app that
 * signed the transaction, so BillFn's exact price ID match applies that app's price instead of its product match, which
 * names no price across plans. Every Apple price must name a listed app (`readPriceBundleId`). Any other product, or an
 * app that sells the product in several plans itself, is left to BillFn's product match, as with one app.
 */
function createCatalogPriceIdResolver(config: ResolvedAppleProviderConfig, catalog: BillFnCatalog | undefined): CatalogPriceIdResolver {
  if (!catalog || config.bundleIds.length < 2) {
    return () => undefined;
  }
  const plansOfProduct = new Map<string, Set<string>>();
  const pricesOfAppProduct = new Map<string, Array<{ planKey: string; priceId: string }>>();
  for (const plan of catalog.plans) {
    for (const price of plan.prices) {
      if (price.provider !== 'apple' || !price.providerProductId) {
        continue;
      }
      const key = JSON.stringify([readPriceBundleId(config, price), price.providerProductId]);
      plansOfProduct.set(price.providerProductId, (plansOfProduct.get(price.providerProductId) ?? new Set()).add(plan.planKey));
      pricesOfAppProduct.set(key, [...(pricesOfAppProduct.get(key) ?? []), { planKey: plan.planKey, priceId: price.priceId }]);
    }
  }
  return (transaction, currentPriceId) => {
    // Both fields are inside Apple's signed transaction; nothing a client sends is read.
    const productId = readString(transaction ?? {}, ['productId']);
    const bundleId = readString(transaction ?? {}, ['bundleId']);
    if (!productId || !bundleId || (plansOfProduct.get(productId)?.size ?? 0) < 2) {
      return undefined;
    }
    const prices = pricesOfAppProduct.get(JSON.stringify([bundleId, productId])) ?? [];
    if (new Set(prices.map((price) => price.planKey)).size !== 1) {
      return undefined;
    }
    return (prices.find((price) => price.priceId === currentPriceId) ?? prices[0]).priceId;
  };
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
 * pagination token, which a single-app adapter returns unchanged and any adapter reads as the first app's.
 */
const NOTIFICATION_HISTORY_CURSOR_PREFIX = 'billfn-apple-history:';

interface NotificationHistoryPosition {
  bundleId: string | undefined;
  paginationToken: string | undefined;
}

/**
 * Reads a stored history cursor. Adapter cursors are read whatever the number of listed apps, so a cursor written
 * before the bundle IDs changed keeps working: one naming a still-listed app continues that app's history, and one
 * naming an app no longer listed restarts from the first listed app, because a cursor that fails would be retried
 * unchanged on every backfill. Replayed notifications are deduplicated by their notification IDs.
 */
function readNotificationHistoryCursor(bundleIds: readonly string[], cursor: string | undefined): NotificationHistoryPosition {
  if (!cursor?.startsWith(NOTIFICATION_HISTORY_CURSOR_PREFIX)) {
    return { bundleId: bundleIds[0], paginationToken: cursor || undefined };
  }
  const position = parseJsonRecord(decodeBase64UrlText(cursor.slice(NOTIFICATION_HISTORY_CURSOR_PREFIX.length)));
  const bundleId = position?.bundleId;
  const paginationToken = position?.paginationToken;
  if (
    typeof bundleId !== 'string' ||
    bundleId.length === 0 ||
    (paginationToken !== undefined && (typeof paginationToken !== 'string' || paginationToken.length === 0))
  ) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'The Apple notification history cursor is malformed'
    });
  }
  if (!bundleIds.includes(bundleId)) {
    return { bundleId: bundleIds[0], paginationToken: undefined };
  }
  return { bundleId, paginationToken };
}

/**
 * Continues the app's history while Apple has more, then starts the next app's; undefined after the last app.
 * With several apps, Apple's `hasMore: false` ends the app's history even when the page carries a token; without
 * `hasMore`, the app's history ends when the page has no token.
 */
function buildNextNotificationHistoryCursor(
  bundleIds: readonly string[],
  bundleId: string | undefined,
  paginationToken: string | undefined,
  hasMore: boolean | undefined
): string | undefined {
  if (bundleIds.length <= 1) {
    return paginationToken;
  }
  const nextBundleId = bundleIds[bundleIds.indexOf(bundleId as string) + 1];
  const continuesApp = Boolean(paginationToken) && hasMore !== false;
  const next = continuesApp ? { bundleId, paginationToken } : nextBundleId === undefined ? undefined : { bundleId: nextBundleId };
  return next && NOTIFICATION_HISTORY_CURSOR_PREFIX + utf8ToBase64Url(JSON.stringify(next));
}

/** Decodes base64url UTF-8 text without Buffer, so it runs on Workers; undecodable input reads as empty text. */
function decodeBase64UrlText(value: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(value));
  } catch {
    return '';
  }
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
  signedPayload: string,
  catalogPriceIdFor: CatalogPriceIdResolver,
  sandboxAccepted: boolean
): BillFnParsedWebhookEvent {
  const notification = decoded.payload;
  const data = asRecord(notification.data) ?? {};
  const decodedTransaction = decodeSignedPayload(data, 'signedTransactionInfo');
  const notificationType = readString(notification, ['notificationType']) ?? 'UNKNOWN';
  const subtype = readString(notification, ['subtype']) ?? undefined;
  // A production deployment that does not accept sandbox purchases applies a notification only when every
  // environment it states is Production (Sandbox, Xcode or LocalTesting purchases cost nothing). Any other one is
  // acknowledged, and applied only when it takes access away (expired, revoked, refunded), so a subscription
  // accepted from the sandbox before can still lapse; nothing from it grants or keeps access.
  const statedEnvironments = [readString(data, ['environment']), readString(decodedTransaction ?? {}, ['environment'])].filter(
    (environment): environment is string => environment !== null && environment !== undefined
  );
  const nonProduction = !sandboxAccepted && statedEnvironments.some((environment) => environment !== 'Production');
  const fullState = mapAppleNotificationState(
    notificationType,
    subtype,
    decodedTransaction,
    decodeSignedPayload(data, 'signedRenewalInfo'),
    readNumber(data, ['status']) ?? undefined
  );
  const ignored = nonProduction && !(fullState && TERMINAL_APPLE_STATES.has(fullState.subscriptionStatus));
  const transaction = ignored ? null : decodedTransaction;
  const state = ignored ? undefined : fullState;

  return {
    providerEventId: readString(notification, ['notificationUUID']) ?? readString(notification, ['notificationId']) ?? signedPayload,
    type: subtype ? `${notificationType}.${subtype}` : notificationType,
    signatureVerified: decoded.signatureVerified,
    occurredAt: millisToIso(readTimestamp(notification, ['signedDate'])) ?? undefined,
    providerSubscriptionId: readString(transaction ?? {}, ['originalTransactionId']) ?? undefined,
    providerChargeId: readString(transaction ?? {}, ['transactionId']) ?? undefined,
    priceId: catalogPriceIdFor(transaction) ?? readString(transaction ?? {}, ['productId']) ?? undefined,
    billingState: state,
    raw: notification
  };
}

/** Whether sandbox purchases and notifications count for this adapter. */
function acceptsSandbox(config: AppleProviderConfig): boolean {
  return (config.environment ?? 'production') === 'sandbox' || config.allowSandbox === true;
}

/** States that only take access away; a notification from a non-production environment may still apply them. */
const TERMINAL_APPLE_STATES: ReadonlySet<string> = new Set(['expired', 'canceled']);

function mapAppleNotificationState(
  notificationType: string,
  subtype: string | undefined,
  transaction: Record<string, unknown> | null,
  renewal: Record<string, unknown> | null,
  /** The notification's `data.status` (1-5): the subscription's status, which the signed transaction does not carry. */
  notificationStatus?: number
): BillFnVerifiedBillingState | undefined {
  if (notificationType === 'TEST') {
    return undefined;
  }

  const baseState = mapTransactionPayload(transaction, renewal);
  if (!baseState) {
    return undefined;
  }
  const transactionState: BillFnVerifiedBillingState =
    notificationStatus === undefined
      ? baseState
      : {
          ...baseState,
          subscriptionStatus: normalizeAppleStatus(notificationStatus),
          checkoutStatus: notificationStatus === 2 ? 'failed' : 'succeeded'
        };

  switch (notificationType) {
    case 'SUBSCRIBED':
    case 'DID_RENEW':
      return {
        ...transactionState,
        subscriptionStatus: 'active',
        checkoutStatus: 'succeeded'
      };
    case 'GRACE_PERIOD_EXPIRED':
      // The grace period ended while Apple keeps retrying the renewal: billing retry, which grants no access.
      return notificationStatus === undefined
        ? { ...transactionState, subscriptionStatus: 'paused', checkoutStatus: 'succeeded' }
        : transactionState;
    case 'DID_FAIL_TO_RENEW':
      return {
        ...transactionState,
        // Without the grace period subtype the subscription is in billing retry, which grants no access.
        subscriptionStatus: subtype === 'GRACE_PERIOD' ? 'grace' : 'paused',
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
    case 'DID_CHANGE_RENEWAL_PREF':
      // A renewal preference change says nothing about payment. The subscription's status comes from the
      // notification's data.status; without it the change carries no state, rather than marking a subscription
      // in billing retry or expired as active.
      if (notificationStatus === undefined) {
        return undefined;
      }
      return notificationType === 'DID_CHANGE_RENEWAL_STATUS'
        ? { ...transactionState, autoRenew: subtype === 'AUTO_RENEW_DISABLED' ? false : transactionState.autoRenew }
        : transactionState;
    default:
      return transactionState;
  }
}

function mapAppleSubscriptionResponse(
  payload: Record<string, unknown>,
  expectation: AppleTransactionExpectation,
  catalogPriceIdFor: CatalogPriceIdResolver,
  currentPriceId?: string
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
    raw: withCatalogPriceId(payload, catalogPriceIdFor(transaction, currentPriceId))
  };
}

function mapAppleHistoryResponse(
  payload: Record<string, unknown>,
  expectation: AppleTransactionExpectation,
  catalogPriceIdFor: CatalogPriceIdResolver,
  currentPriceId?: string
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
    raw: withCatalogPriceId(payload, catalogPriceIdFor(transaction, currentPriceId))
  };
}

/** The StoreKit response with the catalog price ID BillFn matches first, when the transaction's app names one. */
function withCatalogPriceId(payload: Record<string, unknown>, priceId: string | undefined): Record<string, unknown> {
  return priceId ? { ...payload, priceId } : payload;
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
    (expectation.bundleId === null || readString(transaction, ['bundleId']) === expectation.bundleId) &&
    (expectation.productId === null || productId === expectation.productId) &&
    (expectation.appAccountToken === null ||
      appAccountToken?.toLowerCase() === expectation.appAccountToken.toLowerCase()) &&
    (transactionId === expectation.reference || originalTransactionId === expectation.reference)
  );
}

function throwAppleTransactionConflict(): never {
  throw createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: 'Apple transaction does not match the checkout app, product, reference, and billing account token'
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
      // Billing retry: Apple is still trying to collect the renewal and nothing was paid, so it grants no access.
      return 'paused';
    case 4:
      // Billing grace period: the developer chose to keep access while Apple retries.
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
