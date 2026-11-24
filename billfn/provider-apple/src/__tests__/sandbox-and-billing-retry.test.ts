import { describe, expect, it, vi } from 'vitest';
import { createAppleProvider, type AppleProviderConfig } from '../index.js';

// A production deployment accepts sandbox purchases only when the host allows them, billing retry grants no access,
// and client references never change the StoreKit path they are sent to.

function encodePayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

const notFound = () =>
  new Response(JSON.stringify({ errorCode: 4040010, errorMessage: 'Transaction id not found.' }), { status: 404 });

const transaction = (patch: Record<string, unknown> = {}) => ({
  originalTransactionId: 'orig_1',
  transactionId: 'txn_1',
  productId: 'apple.pro.month',
  purchaseDate: Date.parse('2026-04-20T00:00:00.000Z'),
  expiresDate: Date.parse('2026-05-20T00:00:00.000Z'),
  ...patch
});

/** StoreKit's subscription status answer for one transaction in the given status. */
const statusAnswer = (status: number) =>
  Response.json({
    data: [{ lastTransactions: [{ status, signedTransactionInfo: encodePayload(transaction()), signedRenewalInfo: encodePayload({ autoRenewStatus: 1 }) }] }]
  });

function provider(fetchMock: typeof fetch, config: Partial<AppleProviderConfig> = {}) {
  return createAppleProvider({ fetch: fetchMock, tokenProvider: async () => 'test-storekit-token', ...config });
}

async function importReference(apple: ReturnType<typeof provider>, providerReference: string) {
  return apple.importSubscription!({
    providerReference,
    billingAccount: { id: 'ba_user_1' },
    plan: { planKey: 'pro', prices: [] }
  } as never);
}

function notification(verified: Record<string, unknown>, config: Partial<AppleProviderConfig> = {}) {
  return provider(vi.fn() as unknown as typeof fetch, { notificationVerifier: async () => verified, ...config }).parseWebhook!({
    headers: new Headers(),
    rawBody: JSON.stringify({ signedPayload: 'signed' })
  });
}

const renewal = (environment: 'Sandbox' | 'Production') => ({
  notificationUUID: `notif_${environment}`,
  notificationType: 'DID_RENEW',
  signedDate: Date.parse('2026-04-21T00:00:00.000Z'),
  data: {
    environment,
    signedTransactionInfo: encodePayload(transaction({ environment })),
    signedRenewalInfo: encodePayload({ autoRenewStatus: 1 })
  }
});

describe('sandbox purchases in a production deployment', () => {
  it('does not fall back to the sandbox when production does not know a transaction', async () => {
    const fetchMock = vi.fn(async () => notFound()) as unknown as typeof fetch;

    await expect(importReference(provider(fetchMock), 'orig_1')).resolves.toBeNull();
    expect(vi.mocked(fetchMock).mock.calls.map((call) => String(call[0]))).toEqual([
      'https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/orig_1'
    ]);
  });

  it('falls back to the sandbox when the host sets allowSandbox', async () => {
    const fetchMock = vi.fn(async () => notFound()) as unknown as typeof fetch;

    await importReference(provider(fetchMock, { allowSandbox: true }), 'orig_1');

    expect(vi.mocked(fetchMock).mock.calls.map((call) => new URL(String(call[0])).hostname)).toEqual([
      'api.storekit.itunes.apple.com',
      'api.storekit-sandbox.itunes.apple.com'
    ]);
  });

  it('acknowledges a sandbox notification without a billing state or a reference to link', async () => {
    const [event] = (await notification(renewal('Sandbox')))!;

    expect(event!.billingState).toBeUndefined();
    expect(event!.providerSubscriptionId).toBeUndefined();
    expect(event!.providerChargeId).toBeUndefined();
  });

  it('ignores a notification whose transaction is from the sandbox even if the envelope says production', async () => {
    const verified = renewal('Production');
    verified.data.signedTransactionInfo = encodePayload(transaction({ environment: 'Sandbox' }));

    const [event] = (await notification(verified))!;

    expect(event!.billingState).toBeUndefined();
  });

  it.each([
    ['allowSandbox', { allowSandbox: true }],
    ['a sandbox deployment', { environment: 'sandbox' as const }]
  ])('applies a sandbox notification with %s', async (_name, config) => {
    const [event] = (await notification(renewal('Sandbox'), config))!;

    expect(event!.billingState).toMatchObject({ subscriptionStatus: 'active', providerSubscriptionId: 'orig_1' });
  });

  it('applies a production notification by default', async () => {
    const [event] = (await notification(renewal('Production')))!;

    expect(event!.billingState).toMatchObject({ subscriptionStatus: 'active' });
  });
});

describe('Apple billing retry', () => {
  it.each([
    [1, 'active'],
    [3, 'paused'],
    [4, 'grace']
  ])('maps StoreKit status %i to %s', async (status, expected) => {
    const fetchMock = vi.fn(async () => statusAnswer(status)) as unknown as typeof fetch;

    const imported = await importReference(provider(fetchMock), 'orig_1');

    expect(imported?.subscriptionStatus).toBe(expected);
  });

  it.each([
    [undefined, 'paused'],
    ['GRACE_PERIOD', 'grace']
  ])('maps DID_FAIL_TO_RENEW with subtype %s to %s', async (subtype, expected) => {
    const [event] = (await notification({ ...renewal('Production'), notificationType: 'DID_FAIL_TO_RENEW', subtype }))!;

    expect(event!.billingState?.subscriptionStatus).toBe(expected);
  });
});

describe('StoreKit paths built from references', () => {
  it.each([
    ['../transactions/2000000123456789', '..%2Ftransactions%2F2000000123456789'],
    ['x/../../v2/history/2000000999?revoked=true', 'x%2F..%2F..%2Fv2%2Fhistory%2F2000000999%3Frevoked%3Dtrue']
  ])('encodes the restore reference %s as one path segment', async (reference, encoded) => {
    const fetchMock = vi.fn(async () => notFound()) as unknown as typeof fetch;

    await provider(fetchMock)
      .restorePurchases!({
        billingAccount: { id: 'ba_user_1' },
        price: { kind: 'subscription', providerProductId: 'apple.pro.month' },
        purchaseReference: reference
      } as never)
      .catch(() => undefined);

    const url = String(vi.mocked(fetchMock).mock.calls[0]?.[0]);
    expect(url).toBe(`https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/${encoded}`);
  });

  it('encodes a client transactionId in checkout verification', async () => {
    const fetchMock = vi.fn(async () => notFound()) as unknown as typeof fetch;

    await provider(fetchMock)
      .verifyCheckout!({
        checkoutSession: { checkoutSessionId: 'chk_1', billingAccountId: 'ba_user_1' },
        billingAccount: { id: 'ba_user_1' },
        price: { priceId: 'price_apple', kind: 'subscription', providerProductId: 'apple.pro.month' },
        payload: { transactionId: '../transactions/2000000123456789' }
      } as never)
      .catch(() => undefined);

    const url = String(vi.mocked(fetchMock).mock.calls[0]?.[0]);
    expect(url).toBe('https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/..%2Ftransactions%2F2000000123456789');
  });
});
