import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BILLFN_BRIDGE_EVENT_NAMES,
  BILLFN_BRIDGE_METHODS,
  BILLFN_BRIDGE_PROTOCOL,
  createNativeBackedBillFnClient,
  createWKWebViewBridgeBus,
  isBridgeEventEnvelope,
  type BillFnBridgeBus,
  type BillFnBridgeError,
  type BillFnBridgeRequestEnvelope,
  type BillFnBridgeResponseEnvelope
} from '../index.js';

const transaction = {
  transactionId: '2000000001',
  originalTransactionId: '2000000000',
  productId: 'apple.pro.month',
  appAccountToken: '2e54f6b7-3e0d-5b18-98d2-2a2f84a70f7f',
  revoked: false
};

/** A native host that records each request and answers StoreKit methods with `answer`. */
type NativeAnswer = { ok: true; result: unknown } | { ok: false; error: BillFnBridgeError };

function nativeHost(answer: (message: BillFnBridgeRequestEnvelope) => NativeAnswer) {
  const requests: BillFnBridgeRequestEnvelope[] = [];
  const bus: BillFnBridgeBus = {
    async request(message) {
      requests.push(message);
      if (message.method === 'handshake') {
        return {
          protocol: BILLFN_BRIDGE_PROTOCOL,
          id: message.id,
          ok: true,
          result: { bridgeVersion: 1, billingOwner: 'native', authOwner: 'native', capabilities: ['storekit.checkout'] }
        };
      }
      const response: BillFnBridgeResponseEnvelope = { protocol: BILLFN_BRIDGE_PROTOCOL, id: message.id, ...answer(message) };
      return response;
    },
    subscribe() {
      return () => undefined;
    }
  };
  const client = createNativeBackedBillFnClient(
    { clientId: 'web', mode: 'native-backed', baseURL: 'https://billfn.example.test/billfn' },
    bus
  );
  return { client, requests: () => requests.filter((request) => request.method !== 'handshake') };
}

function swiftStringList(source: string, name: string): string[] {
  const match = source.match(new RegExp(`public let ${name}: \\[String\\] = \\[([^\\]]*)\\]`));
  if (!match) throw new Error(`${name} not found in the Swift bridge protocol`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

describe('StoreKit bridge methods', () => {
  it('lists the same methods and events as the Swift bridge host', () => {
    const swift = readFileSync(
      new URL('../../../swift/Sources/BillFnWebViewBridgeHost/BillFnBridgeProtocol.swift', import.meta.url),
      'utf8'
    );

    expect(swiftStringList(swift, 'BILLFN_BRIDGE_METHODS')).toEqual([...BILLFN_BRIDGE_METHODS]);
    expect(swiftStringList(swift, 'BILLFN_BRIDGE_EVENT_NAMES')).toEqual([...BILLFN_BRIDGE_EVENT_NAMES]);
    expect(swiftStringList(swift, 'BILLFN_BRIDGE_STOREKIT_METHODS')).toEqual([
      'storekit.checkout',
      'storekit.restore',
      'storekit.transactions'
    ]);
  });

  it('checkout sends storekit.checkout and returns the native purchase result', async () => {
    const { client, requests } = nativeHost(() => ({
      ok: true,
      result: {
        status: 'purchased',
        checkoutSessionId: 'chk_1',
        productId: 'apple.pro.month',
        outcome: { transaction, status: 'confirmed', finished: true, billing: { subscription: { status: 'active' } } }
      }
    }));
    await client.handshake();

    const result = await client.checkout({ planKey: 'pro', priceId: 'price_pro_apple_month' });

    expect(requests().map(({ method, payload }) => ({ method, payload }))).toEqual([
      { method: 'storekit.checkout', payload: { planKey: 'pro', priceId: 'price_pro_apple_month' } }
    ]);
    expect(result).toMatchObject({ status: 'purchased', outcome: { status: 'confirmed', finished: true } });
  });

  it('returns pending and cancelled checkouts without an outcome', async () => {
    const statuses = ['pending', 'cancelled'] as const;
    for (const status of statuses) {
      const { client } = nativeHost(() => ({
        ok: true,
        result: { status, checkoutSessionId: 'chk_2', productId: 'apple.pro.month' }
      }));
      await client.handshake();
      await expect(client.checkout({ planKey: 'pro' })).resolves.toEqual({
        status,
        checkoutSessionId: 'chk_2',
        productId: 'apple.pro.month'
      });
    }
  });

  it('rejects a checkout without a planKey before calling native code', async () => {
    const { client, requests } = nativeHost(() => ({ ok: true, result: {} }));
    await client.handshake();

    await expect(client.checkout({ planKey: '' })).rejects.toMatchObject({ code: 'BRIDGE_INVALID_REQUEST' });
    await expect(client.checkout(undefined as never)).rejects.toMatchObject({ code: 'BRIDGE_INVALID_REQUEST' });
    expect(requests()).toEqual([]);
  });

  it('restore and transactions return the outcome of each transaction', async () => {
    const outcomes = [
      { transaction, status: 'confirmed', finished: true, billing: {} },
      {
        transaction: { ...transaction, transactionId: '2000000002' },
        status: 'failed',
        finished: false,
        error: { code: 'BILLFN_PROVIDER_ERROR', message: 'Apple unavailable', retryable: true }
      }
    ];
    const { client, requests } = nativeHost(() => ({ ok: true, result: { transactions: outcomes } }));
    await client.handshake();

    await expect(client.restore()).resolves.toEqual({ transactions: outcomes });
    await expect(client.restore({ syncWithAppStore: false })).resolves.toEqual({ transactions: outcomes });
    await expect(client.transactions()).resolves.toEqual({ transactions: outcomes });
    expect(requests().map(({ method, payload }) => ({ method, payload }))).toEqual([
      { method: 'storekit.restore', payload: {} },
      { method: 'storekit.restore', payload: { syncWithAppStore: false } },
      { method: 'storekit.transactions', payload: undefined }
    ]);
  });

  it('rejects a native result that does not match the protocol', async () => {
    const { client } = nativeHost((message) => ({
      ok: true,
      result: message.method === 'storekit.checkout' ? { status: 'purchased', checkoutSessionId: 'chk_3' } : { transactions: 'none' }
    }));
    await client.handshake();

    await expect(client.checkout({ planKey: 'pro' })).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_MISMATCH' });
    await expect(client.restore()).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_MISMATCH' });
    await expect(client.transactions()).rejects.toMatchObject({ code: 'BRIDGE_PROTOCOL_MISMATCH' });
  });

  it('surfaces the native error code and details', async () => {
    const { client } = nativeHost(() => ({
      ok: false,
      error: { code: 'BILLFN_CONFLICT', message: 'Checkout session does not belong to the account', details: { retryable: false } }
    }));
    await client.handshake();

    await expect(client.checkout({ planKey: 'pro' })).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      details: { retryable: false }
    });
  });

  it('requires the handshake before StoreKit methods', async () => {
    const { client, requests } = nativeHost(() => ({ ok: true, result: { transactions: [] } }));

    await expect(client.transactions()).rejects.toMatchObject({ code: 'BRIDGE_HANDSHAKE_REQUIRED' });
    expect(requests()).toEqual([]);
  });

  it('accepts transaction.updated events from the native host', () => {
    expect(
      isBridgeEventEnvelope({
        protocol: BILLFN_BRIDGE_PROTOCOL,
        event: 'transaction.updated',
        payload: { outcome: { transaction, status: 'confirmed', finished: true, billing: {} } }
      })
    ).toBe(true);
  });
});

describe('StoreKit requests over the WKWebView bus', () => {
  type Posted = { id: string; method: string };

  function installNativeHandler() {
    const posted: Posted[] = [];
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { webkit: { messageHandlers: { billfn: { postMessage: (message: Posted) => posted.push(message) } } } }
    });
    const respond = (id: string, result: unknown) =>
      globalThis.window.__billfnBridgeReceive__?.({ protocol: BILLFN_BRIDGE_PROTOCOL, id, ok: true, result });
    const restore = () =>
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    return { posted, respond, restore };
  }

  const purchased = {
    status: 'purchased',
    checkoutSessionId: 'chk_1',
    productId: 'apple.pro.month',
    outcome: { transaction, status: 'confirmed', finished: true, billing: {} }
  };

  it('keeps waiting for a purchase past the generic timeout', async () => {
    vi.useFakeTimers();
    const native = installNativeHandler();
    try {
      const bus = createWKWebViewBridgeBus({ timeoutMs: 30_000 });
      const pending = bus.request({ protocol: BILLFN_BRIDGE_PROTOCOL, id: 'req_buy', method: 'storekit.checkout', payload: { planKey: 'pro' } });
      // The user is still in the App Store purchase sheet well past the generic timeout.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      native.respond('req_buy', purchased);

      await expect(pending).resolves.toEqual({ protocol: BILLFN_BRIDGE_PROTOCOL, id: 'req_buy', ok: true, result: purchased });
    } finally {
      native.restore();
      vi.useRealTimers();
    }
  });

  it('keeps the generic timeout for non-interactive StoreKit and BillFn requests', async () => {
    vi.useFakeTimers();
    const native = installNativeHandler();
    try {
      const bus = createWKWebViewBridgeBus({ timeoutMs: 30_000 });
      const transactions = bus.request({ protocol: BILLFN_BRIDGE_PROTOCOL, id: 'req_tx', method: 'storekit.transactions' });
      await vi.advanceTimersByTimeAsync(30_000);

      const response = await transactions;
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error.code).toBe('BRIDGE_UNAVAILABLE');
    } finally {
      native.restore();
      vi.useRealTimers();
    }
  });

  it('reports an interactive timeout distinctly, as a purchase that may still complete', async () => {
    vi.useFakeTimers();
    const native = installNativeHandler();
    try {
      const bus = createWKWebViewBridgeBus({ interactiveTimeoutMs: 120_000 });
      const checkout = bus.request({ protocol: BILLFN_BRIDGE_PROTOCOL, id: 'req_buy', method: 'storekit.checkout', payload: { planKey: 'pro' } });
      const restore = bus.request({ protocol: BILLFN_BRIDGE_PROTOCOL, id: 'req_restore', method: 'storekit.restore' });
      await vi.advanceTimersByTimeAsync(120_000);

      for (const response of [await checkout, await restore]) {
        expect(response.ok).toBe(false);
        if (!response.ok) {
          expect(response.error.code).toBe('BRIDGE_INTERACTIVE_TIMEOUT');
          expect(response.error.message).toContain('transaction.updated');
        }
      }
      expect(native.posted.map((message) => message.method)).toEqual(['storekit.checkout', 'storekit.restore']);
    } finally {
      native.restore();
      vi.useRealTimers();
    }
  });

  it('waits without a timeout when interactiveTimeoutMs is 0', async () => {
    vi.useFakeTimers();
    const native = installNativeHandler();
    try {
      const bus = createWKWebViewBridgeBus({ interactiveTimeoutMs: 0 });
      const pending = bus.request({ protocol: BILLFN_BRIDGE_PROTOCOL, id: 'req_buy', method: 'storekit.checkout', payload: { planKey: 'pro' } });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      native.respond('req_buy', purchased);

      await expect(pending).resolves.toMatchObject({ ok: true, result: purchased });
    } finally {
      native.restore();
      vi.useRealTimers();
    }
  });

  it('surfaces the interactive timeout through the client as a distinct error', async () => {
    vi.useFakeTimers();
    const native = installNativeHandler();
    try {
      const client = createNativeBackedBillFnClient({
        clientId: 'web',
        mode: 'native-backed',
        baseURL: 'https://billfn.example.test/billfn',
        interactiveTimeoutMs: 1_000
      });
      const handshake = client.handshake();
      native.respond(native.posted[0].id, { bridgeVersion: 1, billingOwner: 'native', authOwner: 'native', capabilities: [] });
      await handshake;

      const checkout = client.checkout({ planKey: 'pro' });
      const assertion = expect(checkout).rejects.toMatchObject({ code: 'BRIDGE_INTERACTIVE_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      native.restore();
      vi.useRealTimers();
    }
  });
});
