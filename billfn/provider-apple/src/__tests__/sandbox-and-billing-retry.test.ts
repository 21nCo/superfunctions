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

  const storedSubscription = {
    subscription: {
      id: 'bsub_1',
      billingAccountId: 'ba_user_1',
      providerSubscriptionId: 'orig_legacy',
      providerChargeId: 'txn_legacy',
      status: 'active',
      autoRenew: true,
      metadata: { billfnImportedAt: '2026-04-01T00:00:00.000Z' }
    },
    price: { priceId: 'price_apple', providerProductId: 'apple.pro.month' }
  };
  /** StoreKit's status answer for one subscription. */
  const subscriptionAnswer = (status: number, originalTransactionId = 'orig_legacy') =>
    Response.json({
      data: [
        {
          lastTransactions: [
            {
              status,
              signedTransactionInfo: encodePayload(transaction({ originalTransactionId, transactionId: `${originalTransactionId}_txn` })),
              signedRenewalInfo: encodePayload({ autoRenewStatus: 1 })
            }
          ]
        }
      ]
    });
  const sandboxAnswers = (sandbox: () => Response) =>
    vi.fn(async (url: RequestInfo | URL) =>
      new URL(String(url)).hostname === 'api.storekit-sandbox.itunes.apple.com' ? sandbox() : notFound()
    ) as unknown as typeof fetch;

  it.each([1, 3, 4])(
    'syncs a stored subscription only the sandbox knows (status %i) as expired, so an account scan ends it',
    async (status) => {
      const state = await provider(sandboxAnswers(() => subscriptionAnswer(status))).fetchSubscription!(storedSubscription as never);

      expect(state).toMatchObject({ subscriptionStatus: 'expired', providerSubscriptionId: 'orig_legacy', autoRenew: false });
    }
  );

  it('keeps a sandbox subscription that already ended as it ended', async () => {
    const state = await provider(sandboxAnswers(() => subscriptionAnswer(5))).fetchSubscription!(storedSubscription as never);

    expect(state).toMatchObject({ subscriptionStatus: 'canceled', autoRenew: false });
  });

  it('rejects a sandbox answer for another subscription, as before', async () => {
    await expect(
      provider(sandboxAnswers(() => subscriptionAnswer(1, 'orig_other'))).fetchSubscription!(storedSubscription as never)
    ).rejects.toBeDefined();
  });

  it.each([
    ['not found in either', () => notFound(), 'BILLFN_PROVIDER_ERROR'],
    ['a sandbox failure (production\'s not-found stands)', () => new Response('', { status: 500 }), 'BILLFN_PROVIDER_ERROR']
  ])('keeps the sync an error when the sandbox answers %s', async (_name, sandbox, code) => {
    await expect(provider(sandboxAnswers(sandbox)).fetchSubscription!(storedSubscription as never)).rejects.toMatchObject({ code });
  });

  it('goes on to the next app\'s production when the first app\'s sandbox read fails', async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(String(url)).hostname;
      const authorization = String((init?.headers as Record<string, string>).authorization);
      requests.push(`${host} ${authorization}`);
      if (host === 'api.storekit-sandbox.itunes.apple.com') {
        return new Response('', { status: 503 });
      }
      return authorization === 'Bearer test-token-com.example.two' ? subscriptionAnswer(1) : notFound();
    }) as unknown as typeof fetch;
    const apple = createAppleProvider({
      fetch: fetchMock,
      bundleIds: ['com.example.one', 'com.example.two'],
      tokenProvider: async (context?: { bundleId: string }) => `test-token-${context?.bundleId}`
    });

    const state = await apple.fetchSubscription!(storedSubscription as never);

    expect(state).toMatchObject({ subscriptionStatus: 'active' });
    expect(requests).toEqual([
      'api.storekit.itunes.apple.com Bearer test-token-com.example.one',
      'api.storekit-sandbox.itunes.apple.com Bearer test-token-com.example.one',
      'api.storekit.itunes.apple.com Bearer test-token-com.example.two'
    ]);
  });

  it('syncs a production subscription from production without reading the sandbox', async () => {
    const fetchMock = vi.fn(async () => subscriptionAnswer(1)) as unknown as typeof fetch;

    const state = await provider(fetchMock).fetchSubscription!(storedSubscription as never);

    expect(state).toMatchObject({ subscriptionStatus: 'active' });
    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(1);
  });

  it('applies a sandbox sync answer as it is when the sandbox is allowed', async () => {
    const state = await provider(sandboxAnswers(() => subscriptionAnswer(1)), { allowSandbox: true }).fetchSubscription!(
      storedSubscription as never
    );

    expect(state).toMatchObject({ subscriptionStatus: 'active' });
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

  it.each(['Xcode', 'LocalTesting'])('ignores a %s notification like a sandbox one', async (environment) => {
    const verified = renewal('Production');
    verified.data.environment = environment as 'Production';

    const [event] = (await notification(verified))!;

    expect(event!.billingState).toBeUndefined();
  });

  it.each([
    ['EXPIRED', undefined, 'expired'],
    ['REVOKE', undefined, 'canceled'],
    ['REFUND', undefined, 'canceled']
  ])('still applies a sandbox %s notification, which only takes access away', async (notificationType, subtype, expected) => {
    const [event] = (await notification({ ...renewal('Sandbox'), notificationType, subtype }))!;

    expect(event!.billingState).toMatchObject({ subscriptionStatus: expected, providerSubscriptionId: 'orig_1' });
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

describe('renewal preference notifications', () => {
  it('keeps a subscription in billing retry unentitled when the customer turns auto-renew off', async () => {
    const failed = { ...renewal('Production'), notificationType: 'DID_FAIL_TO_RENEW', data: { ...renewal('Production').data, status: 3 } };
    const autoRenewOff = {
      ...renewal('Production'),
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_DISABLED',
      data: { ...renewal('Production').data, status: 3 }
    };

    const [first] = (await notification(failed))!;
    const [second] = (await notification(autoRenewOff))!;

    expect(first!.billingState?.subscriptionStatus).toBe('paused');
    expect(second!.billingState).toMatchObject({ subscriptionStatus: 'paused', autoRenew: false });
  });

  it.each([
    [1, 'active'],
    [2, 'expired'],
    [4, 'grace'],
    [5, 'canceled']
  ])('takes the status of a renewal preference change from data.status %i', async (status, expected) => {
    const [event] = (await notification({ ...renewal('Production'), notificationType: 'DID_CHANGE_RENEWAL_PREF', data: { ...renewal('Production').data, status } }))!;

    expect(event!.billingState?.subscriptionStatus).toBe(expected);
  });

  it('records no state for a renewal preference change without data.status', async () => {
    const [event] = (await notification({ ...renewal('Production'), notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_ENABLED' }))!;

    expect(event!.billingState).toBeUndefined();
  });

  it('takes the status of another notification type from data.status', async () => {
    const [event] = (await notification({ ...renewal('Production'), notificationType: 'PRICE_INCREASE', data: { ...renewal('Production').data, status: 3 } }))!;

    expect(event!.billingState?.subscriptionStatus).toBe('paused');
  });
});

describe('StoreKit paths built from references', () => {
  it('refuses a reference that cannot be encoded as invalid input', async () => {
    const fetchMock = vi.fn(async () => notFound()) as unknown as typeof fetch;

    await expect(
      provider(fetchMock).restorePurchases!({
        billingAccount: { id: 'ba_user_1' },
        price: { kind: 'subscription', providerProductId: 'apple.pro.month' },
        purchaseReference: 'txn_\ud800'
      } as never)
    ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
