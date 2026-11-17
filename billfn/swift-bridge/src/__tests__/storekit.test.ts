import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BILLFN_BRIDGE_EVENT_NAMES,
  BILLFN_BRIDGE_METHODS,
  BILLFN_BRIDGE_PROTOCOL,
  createNativeBackedBillFnClient,
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
