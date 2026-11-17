import {
  BILLFN_BRIDGE_PROTOCOL,
  isBridgeHandshakeResult,
  nextBridgeRequestId,
  type BillFnBridgeBus,
  type BillFnBridgeError,
  type BillFnBridgeEventEnvelope,
  type BillFnBridgeHandshakeResult,
  type BillFnBridgeMethod,
  type BillFnBridgeRequestEnvelope,
  type BillFnBridgeResponseEnvelope,
  type BillFnStoreKitCheckoutResult,
  type BillFnStoreKitTransactionsResult,
  type CreateNativeBackedBillFnClientOptions,
  type NativeBackedBillFnClient
} from './protocol.js';
import { createWKWebViewBridgeBus } from './wkwebviewBus.js';

export class BillFnBridgeClientError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: BillFnBridgeError['code'], message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BillFnBridgeClientError';
    this.code = code;
    this.details = details;
  }
}

function assertBridgeSuccess(
  response: BillFnBridgeResponseEnvelope
): asserts response is Extract<BillFnBridgeResponseEnvelope, { ok: true }> {
  if (!response.ok) {
    throw new BillFnBridgeClientError(response.error.code, response.error.message, response.error.details);
  }
}

function buildRequest(
  method: BillFnBridgeRequestEnvelope['method'],
  payload?: unknown
): BillFnBridgeRequestEnvelope {
  return {
    protocol: BILLFN_BRIDGE_PROTOCOL,
    id: nextBridgeRequestId(),
    method,
    payload
  };
}

const STOREKIT_CHECKOUT_STATUSES = new Set(['purchased', 'pending', 'cancelled']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResult(method: string): never {
  throw new BillFnBridgeClientError('BRIDGE_PROTOCOL_MISMATCH', `Native bridge returned an invalid ${method} result`);
}

function isTransaction(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.transactionId === 'string' &&
    typeof value.originalTransactionId === 'string' &&
    typeof value.productId === 'string' &&
    (value.appAccountToken === null || typeof value.appAccountToken === 'string') &&
    typeof value.revoked === 'boolean'
  );
}

function isTransactionOutcome(value: unknown): boolean {
  if (!isRecord(value) || !isTransaction(value.transaction)) {
    return false;
  }
  switch (value.status) {
    case 'confirmed':
      return value.finished === true && 'billing' in value;
    case 'failed':
      return (
        value.finished === false &&
        isRecord(value.error) &&
        typeof value.error.code === 'string' &&
        typeof value.error.message === 'string' &&
        typeof value.error.retryable === 'boolean'
      );
    case 'skipped':
      return value.finished === false && typeof value.reason === 'string';
    default:
      return false;
  }
}

function assertCheckoutResult(value: unknown): asserts value is BillFnStoreKitCheckoutResult {
  if (
    !isRecord(value) ||
    typeof value.status !== 'string' ||
    !STOREKIT_CHECKOUT_STATUSES.has(value.status) ||
    typeof value.checkoutSessionId !== 'string' ||
    typeof value.productId !== 'string' ||
    (value.status === 'purchased' && !isTransactionOutcome(value.outcome))
  ) {
    invalidResult('storekit.checkout');
  }
}

function assertTransactionsResult(value: unknown, method: string): asserts value is BillFnStoreKitTransactionsResult {
  if (!isRecord(value) || !Array.isArray(value.transactions) || !value.transactions.every(isTransactionOutcome)) {
    invalidResult(method);
  }
}

export function createNativeBackedBillFnClient(
  options: CreateNativeBackedBillFnClientOptions,
  bus: BillFnBridgeBus = createWKWebViewBridgeBus(options)
): NativeBackedBillFnClient {
  let handshakeResult: BillFnBridgeHandshakeResult | null = null;

  const request = async (
    method: Exclude<BillFnBridgeMethod, 'handshake'>,
    payload?: unknown
  ): Promise<unknown> => {
    if (handshakeResult == null) {
      throw new BillFnBridgeClientError(
        'BRIDGE_HANDSHAKE_REQUIRED',
        'handshake must complete before native-backed requests'
      );
    }

    const response = await bus.request(buildRequest(method, payload));
    assertBridgeSuccess(response);
    return response.result;
  };

  return {
    async handshake() {
      const response = await bus.request(
        buildRequest('handshake', {
          clientId: options.clientId,
          mode: options.mode,
          baseURL: options.baseURL
        })
      );

      assertBridgeSuccess(response);
      if (!isBridgeHandshakeResult(response.result)) {
        throw new BillFnBridgeClientError(
          'BRIDGE_PROTOCOL_MISMATCH',
          'Native bridge returned an invalid handshake payload'
        );
      }

      handshakeResult = response.result;
      return handshakeResult;
    },
    request,
    getBillingStatus(payload) {
      return request('billing.status', payload);
    },
    getEntitlements(payload) {
      return request('entitlements.get', payload);
    },
    getUsage(payload) {
      return request('usage.get', payload);
    },
    createCheckout(payload) {
      return request('checkout.create', payload);
    },
    verifyCheckout(payload) {
      return request('checkout.verify', payload);
    },
    restorePurchase(payload) {
      return request('purchase.restore', payload);
    },
    syncSubscription(payload) {
      return request('subscription.sync', payload);
    },
    cancelSubscription(payload) {
      return request('subscription.cancel', payload);
    },
    changeSubscription(payload) {
      return request('subscription.change', payload);
    },
    resumeSubscription(payload) {
      return request('subscription.resume', payload);
    },
    manageSubscription(payload) {
      return request('subscription.manage', payload);
    },
    healthCheck(payload) {
      return request('health.check', payload);
    },
    async checkout(payload) {
      if (!isRecord(payload) || typeof payload.planKey !== 'string' || payload.planKey.length === 0) {
        throw new BillFnBridgeClientError('BRIDGE_INVALID_REQUEST', 'checkout requires a planKey');
      }
      const result = await request('storekit.checkout', payload);
      assertCheckoutResult(result);
      return result;
    },
    async restore(payload) {
      const result = await request('storekit.restore', payload ?? {});
      assertTransactionsResult(result, 'storekit.restore');
      return result;
    },
    async transactions() {
      const result = await request('storekit.transactions');
      assertTransactionsResult(result, 'storekit.transactions');
      return result;
    },
    subscribe(handler: (event: BillFnBridgeEventEnvelope) => void) {
      return bus.subscribe(handler);
    }
  };
}
