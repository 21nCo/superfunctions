export const BILLFN_BRIDGE_PROTOCOL = 'billfn-bridge/v1' as const;

export const BILLFN_BRIDGE_CAPABILITIES = [
  'billing',
  'entitlements',
  'usage',
  'checkout',
  'subscriptions',
  'purchases',
  'health',
  'events',
  // The Swift host advertises each StoreKit method it answers as a capability of the same name.
  'storekit.checkout',
  'storekit.restore',
  'storekit.transactions'
] as const;

export const BILLFN_BRIDGE_METHODS = [
  'handshake',
  'billing.status',
  'entitlements.get',
  'usage.get',
  'checkout.create',
  'checkout.verify',
  'purchase.restore',
  'subscription.sync',
  'subscription.cancel',
  'subscription.change',
  'subscription.resume',
  'subscription.manage',
  'health.check',
  'storekit.checkout',
  'storekit.restore',
  'storekit.transactions'
] as const;

export const BILLFN_BRIDGE_EVENT_NAMES = [
  'bridge.ready',
  'bridge.closed',
  'subscription.changed',
  'entitlements.changed',
  'health.changed',
  'transaction.updated'
] as const;

export type BillFnBridgeMethod = (typeof BILLFN_BRIDGE_METHODS)[number];
export type BillFnBridgeEventName = (typeof BILLFN_BRIDGE_EVENT_NAMES)[number];
export type BillFnBridgeCapability = (typeof BILLFN_BRIDGE_CAPABILITIES)[number];
export type BillFnBridgeErrorCode =
  | 'BRIDGE_PROTOCOL_MISMATCH'
  | 'BRIDGE_METHOD_UNSUPPORTED'
  | 'BRIDGE_UNAVAILABLE'
  /** An interactive StoreKit request timed out; the purchase may still complete and arrive as `transaction.updated`. */
  | 'BRIDGE_INTERACTIVE_TIMEOUT'
  | 'BRIDGE_HANDSHAKE_REQUIRED'
  | 'BRIDGE_INVALID_REQUEST'
  | 'BILLFN_CLIENT_ERROR'
  | 'BILLFN_CAPABILITY_UNAVAILABLE'
  | (string & {});

export interface BillFnBridgeError {
  code: BillFnBridgeErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface BillFnBridgeRequestEnvelope {
  protocol: typeof BILLFN_BRIDGE_PROTOCOL;
  id: string;
  method: BillFnBridgeMethod;
  payload?: unknown;
}

export type BillFnBridgeResponseEnvelope =
  | {
      protocol: typeof BILLFN_BRIDGE_PROTOCOL;
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      protocol: typeof BILLFN_BRIDGE_PROTOCOL;
      id: string;
      ok: false;
      error: BillFnBridgeError;
    };

export interface BillFnBridgeEventEnvelope {
  protocol: typeof BILLFN_BRIDGE_PROTOCOL;
  event: BillFnBridgeEventName;
  payload: unknown;
}

export interface CreateWKWebViewBridgeBusOptions {
  handlerName?: string;
  /** How long a request waits for the native host. Defaults to 30 seconds. */
  timeoutMs?: number;
  /**
   * How long `storekit.checkout` and `storekit.restore` wait: they last as long as the App Store purchase
   * sheet or sign-in is open. Defaults to 10 minutes; `0` waits without a timeout.
   */
  interactiveTimeoutMs?: number;
}

/** The bridge methods that wait on the user in the App Store purchase sheet or sign-in. */
export const BILLFN_BRIDGE_INTERACTIVE_METHODS: readonly BillFnBridgeMethod[] = ['storekit.checkout', 'storekit.restore'];

export interface BillFnBridgeHandshakePayload {
  clientId: string;
  mode: 'native-backed' | 'web-owned';
  baseURL: string;
}

export interface BillFnBridgeHandshakeResult {
  bridgeVersion: number;
  billingOwner: 'native';
  authOwner: 'native' | 'web';
  capabilities: string[];
}

export interface BillFnStoreKitCheckoutPayload {
  planKey: string;
  priceId?: string;
  interval?: string;
}

export interface BillFnStoreKitRestorePayload {
  /** Defaults to true: StoreKit's AppStore.sync, which may ask the user to sign in. */
  syncWithAppStore?: boolean;
}

export interface BillFnStoreKitTransaction {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  appAccountToken: string | null;
  revoked: boolean;
}

/**
 * What BillFn did with one StoreKit transaction. Only a `confirmed` transaction is finished;
 * a `failed` or `skipped` one stays unfinished and is retried on the app's next launch.
 */
export type BillFnStoreKitTransactionOutcome =
  | { transaction: BillFnStoreKitTransaction; status: 'confirmed'; finished: true; billing: unknown }
  | {
      transaction: BillFnStoreKitTransaction;
      status: 'failed';
      finished: false;
      error: { code: string; message: string; retryable: boolean };
    }
  | { transaction: BillFnStoreKitTransaction; status: 'skipped'; finished: false; reason: string };

export type BillFnStoreKitCheckoutResult =
  | {
      status: 'purchased';
      checkoutSessionId: string;
      productId: string;
      outcome: BillFnStoreKitTransactionOutcome;
    }
  | { status: 'pending' | 'cancelled'; checkoutSessionId: string; productId: string };

export interface BillFnStoreKitTransactionsResult {
  transactions: BillFnStoreKitTransactionOutcome[];
}

export interface CreateNativeBackedBillFnClientOptions
  extends CreateWKWebViewBridgeBusOptions,
    BillFnBridgeHandshakePayload {}

export interface BillFnBridgeBus {
  request(message: BillFnBridgeRequestEnvelope): Promise<BillFnBridgeResponseEnvelope>;
  subscribe(handler: (event: BillFnBridgeEventEnvelope) => void): () => void;
}

export interface NativeBackedBillFnClient {
  handshake(): Promise<BillFnBridgeHandshakeResult>;
  request(method: Exclude<BillFnBridgeMethod, 'handshake'>, payload?: unknown): Promise<unknown>;
  getBillingStatus(payload?: unknown): Promise<unknown>;
  getEntitlements(payload?: unknown): Promise<unknown>;
  getUsage(payload?: unknown): Promise<unknown>;
  createCheckout(payload: unknown): Promise<unknown>;
  verifyCheckout(payload: unknown): Promise<unknown>;
  restorePurchase(payload: unknown): Promise<unknown>;
  syncSubscription(payload?: unknown): Promise<unknown>;
  cancelSubscription(payload?: unknown): Promise<unknown>;
  changeSubscription(payload: unknown): Promise<unknown>;
  resumeSubscription(payload?: unknown): Promise<unknown>;
  manageSubscription(payload?: unknown): Promise<unknown>;
  healthCheck(payload?: unknown): Promise<unknown>;
  /** Buys the plan with StoreKit 2 in the native app; the transaction is finished once BillFn verifies it. */
  checkout(payload: BillFnStoreKitCheckoutPayload): Promise<BillFnStoreKitCheckoutResult>;
  /** Restores the App Store purchases onto the BillFn billing account. */
  restore(payload?: BillFnStoreKitRestorePayload): Promise<BillFnStoreKitTransactionsResult>;
  /** Confirms the unfinished StoreKit transactions with BillFn now and returns their outcomes. */
  transactions(): Promise<BillFnStoreKitTransactionsResult>;
  subscribe(handler: (event: BillFnBridgeEventEnvelope) => void): () => void;
}

declare global {
  interface Window {
    __billfnBridgeReceive__?: (message: unknown) => void;
    webkit?: {
      messageHandlers?: Record<string, { postMessage: (message: unknown) => void }>;
    };
  }
}

const BRIDGE_METHOD_SET = new Set<string>(BILLFN_BRIDGE_METHODS);
const BRIDGE_EVENT_SET = new Set<string>(BILLFN_BRIDGE_EVENT_NAMES);
let bridgeRequestSequence = 0;

export function isBillFnBridgeMethod(method: string): method is BillFnBridgeMethod {
  return BRIDGE_METHOD_SET.has(method);
}

export function isBridgeEventEnvelope(value: unknown): value is BillFnBridgeEventEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { protocol?: unknown }).protocol === BILLFN_BRIDGE_PROTOCOL &&
    typeof (value as { event?: unknown }).event === 'string' &&
    BRIDGE_EVENT_SET.has((value as { event: string }).event)
  );
}

export function isBridgeResponseEnvelope(value: unknown): value is BillFnBridgeResponseEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { protocol?: unknown }).protocol === BILLFN_BRIDGE_PROTOCOL &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

export function isBridgeHandshakeResult(value: unknown): value is BillFnBridgeHandshakeResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { bridgeVersion?: unknown }).bridgeVersion === 'number' &&
    typeof (value as { billingOwner?: unknown }).billingOwner === 'string' &&
    Array.isArray((value as { capabilities?: unknown }).capabilities)
  );
}

export function nextBridgeRequestId() {
  let nonce: string | undefined;
  try {
    nonce = globalThis.crypto?.randomUUID?.();
  } catch {
    nonce = undefined;
  }
  if (!nonce) {
    bridgeRequestSequence = (bridgeRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
    nonce = `fallback-${bridgeRequestSequence.toString(36)}`;
  }
  return `bridge-${Date.now()}-${nonce}`;
}

export function createBridgeErrorResponse(
  id: string,
  code: BillFnBridgeErrorCode,
  message: string,
  details?: Record<string, unknown>
): BillFnBridgeResponseEnvelope {
  return {
    protocol: BILLFN_BRIDGE_PROTOCOL,
    id,
    ok: false,
    error: {
      code,
      message,
      details
    }
  };
}
