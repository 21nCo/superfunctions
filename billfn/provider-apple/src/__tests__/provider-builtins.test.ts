import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { generateAppleChain, sampleSubscribedNotification, signJws } from './fixtures/generated-chain.js';

/**
 * The provider's default verifier pins the bundled Apple root. Here the bundled root and its pin are replaced by a
 * generated root, so a notification signed by its chain exercises the provider's built-in wiring end to end; a chain
 * from any other root still fails.
 */
const trusted = vi.hoisted(() => ({ chain: undefined as ReturnType<typeof generateAppleChain> | undefined }));

vi.mock('../apple-root-ca.js', async () => {
  const { generateAppleChain: generate, sha256Hex: digest } = await import('./fixtures/generated-chain.js');
  trusted.chain = generate();
  return { APPLE_ROOT_CA_G3: trusted.chain.root.base64, APPLE_ROOT_CA_G3_SHA256: digest(trusted.chain.root.der) };
});

const { createAppleProvider } = await import('../index.js');
const chain = trusted.chain!;
const apiKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const appStoreServerApiKey = {
  issuerId: '57246542-96fe-1a63-e053-0824d011072a',
  keyId: '2X9R4HXF34',
  privateKey: apiKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
};

const webhook = (signedPayload: string) => ({ headers: {}, rawBody: JSON.stringify({ signedPayload }) });

describe('createAppleProvider built-in verifier and signer', () => {
  it('verifies a notification with the built-in verifier when only bundleId is configured', async () => {
    const provider = createAppleProvider({ bundleId: 'com.example', appStoreServerApiKey });
    const events = await provider.parseWebhook!(webhook(signJws(sampleSubscribedNotification(chain), chain)));
    expect(events).toEqual([
      expect.objectContaining({
        providerEventId: '002e14d5-51f5-4503-b5a8-c3a1af68eb20',
        type: 'SUBSCRIBED.INITIAL_BUY',
        signatureVerified: true,
        providerSubscriptionId: '12345',
        providerChargeId: '23456',
        billingState: expect.objectContaining({ subscriptionStatus: 'active', autoRenew: true })
      })
    ]);
    expect(provider.capabilities.notificationHistory).toBe(true);
  });

  it('rejects a notification from another root, or for another app, as an invalid signature', async () => {
    const provider = createAppleProvider({ bundleId: 'com.example', appStoreServerApiKey });
    const other = generateAppleChain();
    await expect(provider.parseWebhook!(webhook(signJws(sampleSubscribedNotification(other), other)))).rejects.toMatchObject({
      code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID',
      details: { reason: 'untrusted_root' }
    });
    await expect(
      provider.parseWebhook!(webhook(signJws(sampleSubscribedNotification(chain, { bundleId: 'com.other' }), chain)))
    ).rejects.toMatchObject({ code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID', details: { reason: 'bundle_id_mismatch' } });
  });

  it('returns a notification history page that mixes billing, RESCIND_CONSENT and UNCLAIM_SEATS notifications', async () => {
    const scope = { bundleId: 'com.example', environment: 'Production' };
    const signedPayloads = [
      signJws(sampleSubscribedNotification(chain), chain),
      signJws({ notificationType: 'RESCIND_CONSENT', notificationUUID: 'rescind-1', appData: { appAppleId: 1234567890, ...scope } }, chain),
      signJws(
        { notificationType: 'UNCLAIM_SEATS', notificationUUID: 'unclaim-1', unclaimInfo: { originalTransactionId: '12345', unclaimSeatIds: ['seat-1'], ...scope } },
        chain
      )
    ];
    const fetchMock = vi.fn(async () =>
      Response.json({ notificationHistory: signedPayloads.map((signedPayload) => ({ signedPayload })), paginationToken: 'next' })
    );
    const provider = createAppleProvider({ bundleId: 'com.example', appStoreServerApiKey, fetch: fetchMock as typeof fetch });
    const page = await provider.fetchNotificationHistory!({ limit: 10 });
    expect(page.nextCursor).toBe('next');
    expect(page.events).toEqual([
      expect.objectContaining({ type: 'SUBSCRIBED.INITIAL_BUY', signatureVerified: true, billingState: expect.objectContaining({ subscriptionStatus: 'active' }) }),
      expect.objectContaining({ providerEventId: 'rescind-1', type: 'RESCIND_CONSENT', signatureVerified: true, billingState: undefined }),
      expect.objectContaining({ providerEventId: 'unclaim-1', type: 'UNCLAIM_SEATS', signatureVerified: true, billingState: undefined })
    ]);
  });

  it("uses the host's verifier over the built-in one", async () => {
    const notificationVerifier = vi.fn(async () => null);
    const provider = createAppleProvider({ bundleId: 'com.example', appStoreServerApiKey, notificationVerifier });
    await expect(provider.parseWebhook!(webhook(signJws(sampleSubscribedNotification(chain), chain)))).rejects.toMatchObject({
      code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID'
    });
    expect(notificationVerifier).toHaveBeenCalledTimes(1);
  });

  it('signs StoreKit and Advanced Commerce requests with the built-in signer', async () => {
    const authorizations: string[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(String((init?.headers as Record<string, string>).authorization));
      return Response.json({});
    });
    const provider = createAppleProvider({
      bundleId: 'com.example',
      appStoreServerApiKey,
      fetch: fetchMock as typeof fetch,
      advancedCommerce: { enabled: true }
    });
    await provider.cancelSubscription!({
      subscription: { providerChargeId: 'txn_1', providerSubscriptionId: 'orig_1' }
    } as never);
    await expect(provider.importSubscription!({ providerReference: 'orig_1' } as never)).rejects.toBeDefined();
    expect(authorizations).toHaveLength(2);
    for (const authorization of authorizations) {
      const [header, payload, signature] = authorization.replace(/^Bearer /, '').split('.');
      expect(
        verify('sha256', Buffer.from(`${header}.${payload}`), { key: apiKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
      ).toBe(true);
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ bid: 'com.example', aud: 'appstoreconnect-v1' });
    }
  });

  it("uses the host's token provider over the built-in signer", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    const provider = createAppleProvider({
      bundleId: 'com.example',
      appStoreServerApiKey,
      tokenProvider: async () => 'host-token',
      fetch: fetchMock as typeof fetch
    });
    await expect(provider.importSubscription!({ providerReference: 'orig_1' } as never)).rejects.toBeDefined();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { authorization: 'Bearer host-token' } });
  });

  it('requires a token provider, or bundleId with an App Store Server API key', () => {
    expect(() => createAppleProvider({})).toThrow(/tokenProvider, or bundleId with appStoreServerApiKey/);
    expect(() => createAppleProvider({ appStoreServerApiKey })).toThrow(/bundleId/);
    expect(() => createAppleProvider({ bundleId: '', tokenProvider: async () => 't' })).toThrow(/bundleId/);
  });
});

describe('createAppleProvider with several bundle IDs', () => {
  const bundleIds = ['com.example.one', 'com.example.two'];
  /** The app that owns the StoreKit transactions below; StoreKit answers not-found to a token for any other app. */
  const owner = 'com.example.two';

  const claimsOf = (init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /, '');
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { bid: string };
  };
  const notFound = () => Response.json({ errorCode: 4040010, errorMessage: 'Transaction id not found.' }, { status: 404 });
  const signedTransaction = (appAccountToken?: string) =>
    signJws(
      {
        transactionId: 'txn_1',
        originalTransactionId: 'orig_1',
        bundleId: owner,
        productId: 'com.example.product',
        purchaseDate: 1698148800000,
        expiresDate: 1700827200000,
        environment: 'Production',
        ...(appAccountToken ? { appAccountToken } : {})
      },
      chain
    );

  /** A StoreKit and Advanced Commerce double that records each request's host, path and token `bid`. */
  function storeKit(appAccountToken?: string) {
    const requests: Array<{ url: string; bid: string }> = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { bid } = claimsOf(init);
      requests.push({ url: String(url), bid });
      if (String(url).includes('/advancedCommerce/')) {
        return Response.json({});
      }
      if (bid !== owner) {
        return notFound();
      }
      if (String(url).includes('/inApps/v1/transactions/')) {
        return Response.json({ signedTransactionInfo: signedTransaction(appAccountToken) });
      }
      if (String(url).includes('/inApps/v2/history/')) {
        return Response.json({ bundleId: owner, environment: 'Production', signedTransactions: [signedTransaction(appAccountToken)] });
      }
      return Response.json({
        bundleId: owner,
        environment: 'Production',
        data: [{ lastTransactions: [{ originalTransactionId: 'orig_1', status: 1, signedTransactionInfo: signedTransaction(appAccountToken) }] }]
      });
    });
    return { requests, fetchMock: fetchMock as typeof fetch };
  }

  it("signs each StoreKit request for the app it asks, and succeeds with the transaction's own app as bid", async () => {
    const { requests, fetchMock } = storeKit();
    const provider = createAppleProvider({ allowSandbox: true, bundleIds, appStoreServerApiKey, fetch: fetchMock });
    const state = await provider.importSubscription!({ providerReference: 'orig_1' } as never);
    expect(state).toMatchObject({ providerSubscriptionId: 'orig_1' });
    expect(requests).toEqual([
      { url: 'https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/orig_1', bid: 'com.example.one' },
      { url: 'https://api.storekit-sandbox.itunes.apple.com/inApps/v1/subscriptions/orig_1', bid: 'com.example.one' },
      { url: 'https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/orig_1', bid: 'com.example.two' }
    ]);
    // The request StoreKit answered claimed the bundle ID of the transaction it returned.
    const [group] = (state!.raw as { data: Array<{ lastTransactions: Array<{ signedTransactionInfo: string }> }> }).data;
    const returned = JSON.parse(Buffer.from(group.lastTransactions[0].signedTransactionInfo.split('.')[1], 'base64url').toString());
    expect(returned.bundleId).toBe(requests.at(-1)!.bid);
  });

  it("never claims a bundle ID the checkout payload names outside Apple's signed data", async () => {
    const price = { kind: 'subscription', providerProductId: 'com.example.product', metadata: { appleBundleId: owner } };
    const checkout = await createAppleProvider({ bundleIds, appStoreServerApiKey }).createCheckout!({
      billingAccount: { id: 'acct_1' },
      price
    } as never);
    const appAccountToken = String(checkout.clientAction?.metadata?.appAccountToken);
    const { requests, fetchMock } = storeKit(appAccountToken);
    const provider = createAppleProvider({ bundleIds, appStoreServerApiKey, fetch: fetchMock });
    await expect(
      provider.verifyCheckout!({
        billingAccount: { id: 'acct_1' },
        price,
        payload: { transactionId: 'txn_1', bundleId: 'com.example.other' }
      } as never)
    ).resolves.toMatchObject({ providerChargeId: 'txn_1', subscriptionStatus: 'active' });
    // The token claims the app the catalog price names, not the payload's bundle ID.
    expect(requests.map((request) => request.bid)).toEqual([owner]);
  });

  it("finds the transaction's app before an Advanced Commerce request and signs it for that app", async () => {
    const { requests, fetchMock } = storeKit();
    const provider = createAppleProvider({ allowSandbox: true, bundleIds, appStoreServerApiKey, fetch: fetchMock, advancedCommerce: { enabled: true } });
    await provider.cancelSubscription!({ subscription: { providerChargeId: 'txn_1', providerSubscriptionId: 'orig_1' } } as never);
    expect(requests.at(-1)).toEqual({
      url: 'https://api.storekit.itunes.apple.com/advancedCommerce/v1/subscription/cancel/txn_1',
      bid: owner
    });
    expect(requests.slice(0, -1).map((request) => request.bid)).toEqual(['com.example.one', 'com.example.one', 'com.example.two']);
  });

  it("finds the transaction's app before an Advanced Commerce refund and asks the host's token provider for that app", async () => {
    const { requests, fetchMock: storeKitFetch } = storeKit();
    const advancedCommerceRequests: Array<{ url: string; authorization: string }> = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).includes('/advancedCommerce/')) {
        return storeKitFetch(url, init);
      }
      advancedCommerceRequests.push({ url: String(url), authorization: String((init?.headers as Record<string, string>).authorization) });
      return Response.json({});
    });
    const tokenProvider = vi.fn(async (context?: { bundleId: string }) => `host-advanced-commerce-token-for-${context?.bundleId}`);
    const provider = createAppleProvider({
      allowSandbox: true,
      bundleIds,
      appStoreServerApiKey,
      fetch: fetchMock as typeof fetch,
      advancedCommerce: { enabled: true, tokenProvider }
    });
    await provider.refundCharge!({ providerChargeId: 'txn_1', reason: 'customer_request' } as never);
    expect(requests).toEqual([
      { url: 'https://api.storekit.itunes.apple.com/inApps/v1/transactions/txn_1', bid: 'com.example.one' },
      { url: 'https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/txn_1', bid: 'com.example.one' },
      { url: 'https://api.storekit.itunes.apple.com/inApps/v1/transactions/txn_1', bid: owner }
    ]);
    expect(tokenProvider).toHaveBeenCalledExactlyOnceWith({ bundleId: owner });
    expect(advancedCommerceRequests).toEqual([
      {
        url: 'https://api.storekit.itunes.apple.com/advancedCommerce/v1/subscription/revoke/txn_1',
        authorization: `Bearer host-advanced-commerce-token-for-${owner}`
      }
    ]);
  });

  it.each(['custom', 'prorated_remaining_period'] as const)(
    'refuses a %s (partial) refund before any Apple request instead of revoking the transaction',
    async (mode) => {
      const fetchMock = vi.fn(async () => Response.json({}));
      const provider = createAppleProvider({
        bundleIds,
        appStoreServerApiKey,
        fetch: fetchMock as typeof fetch,
        advancedCommerce: { enabled: true, tokenProvider: async () => 'test-advanced-commerce-token' }
      });

      await expect(
        provider.refundCharge!({ providerChargeId: 'txn_1', mode, amount: 600, reason: 'customer_request' } as never)
      ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('refuses a full refund that names an amount before any Apple request', async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    const provider = createAppleProvider({
      bundleIds,
      appStoreServerApiKey,
      fetch: fetchMock as typeof fetch,
      advancedCommerce: { enabled: true, tokenProvider: async () => 'test-advanced-commerce-token' }
    });

    await expect(
      provider.refundCharge!({ providerChargeId: 'txn_1', mode: 'full', amount: 600, reason: 'customer_request' } as never)
    ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores a one-time purchase from the transaction history of the app its price is sold in', async () => {
    const price = { kind: 'one_time', providerProductId: 'com.example.product', metadata: { appleBundleId: owner } };
    const checkout = await createAppleProvider({ bundleIds, appStoreServerApiKey }).createCheckout!({
      billingAccount: { id: 'acct_1' },
      price
    } as never);
    const { requests, fetchMock } = storeKit(String(checkout.clientAction?.metadata?.appAccountToken));
    const provider = createAppleProvider({ bundleIds, appStoreServerApiKey, fetch: fetchMock });
    const restored = await provider.restorePurchases!({
      billingAccount: { id: 'acct_1' },
      price,
      purchaseReference: 'txn_1'
    } as never);
    expect(restored).toEqual([expect.objectContaining({ providerProductId: 'com.example.product' })]);
    expect(requests).toEqual([{ url: 'https://api.storekit.itunes.apple.com/inApps/v2/history/txn_1', bid: owner }]);
  });

  it("stops at the first answer that is not StoreKit's not-found", async () => {
    const fetchMock = vi.fn(async () => Response.json({ errorCode: 4010001 }, { status: 401 }));
    const provider = createAppleProvider({ bundleIds, appStoreServerApiKey, fetch: fetchMock as typeof fetch });
    await expect(provider.importSubscription!({ providerReference: 'orig_1' } as never)).rejects.toMatchObject({
      code: 'BILLFN_PROVIDER_ERROR'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a transaction no listed app owns as not found', async () => {
    const fetchMock = vi.fn(async () => notFound());
    const provider = createAppleProvider({ allowSandbox: true, bundleIds, appStoreServerApiKey, fetch: fetchMock as typeof fetch });
    await expect(provider.importSubscription!({ providerReference: 'orig_1' } as never)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('asks each listed app only in production by default', async () => {
    const fetchMock = vi.fn(async () => notFound());
    const provider = createAppleProvider({ bundleIds, appStoreServerApiKey, fetch: fetchMock as typeof fetch });
    await expect(provider.importSubscription!({ providerReference: 'orig_1' } as never)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => new URL(String((call as unknown[])[0])).hostname === 'api.storekit.itunes.apple.com')).toBe(true);
  });

  it("passes the bundle ID to the host's token provider", async () => {
    const authorizations: string[] = [];
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const authorization = String((init?.headers as Record<string, string>).authorization);
      authorizations.push(authorization);
      return authorization === `Bearer host-token-for-${owner}`
        ? Response.json({ data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: signedTransaction() }] }] })
        : notFound();
    });
    const tokenProvider = vi.fn(async (context?: { bundleId: string }) => `host-token-for-${context?.bundleId}`);
    const provider = createAppleProvider({ allowSandbox: true, bundleIds, tokenProvider, fetch: fetchMock as typeof fetch });
    await expect(provider.importSubscription!({ providerReference: 'orig_1' } as never)).resolves.toMatchObject({
      providerSubscriptionId: 'orig_1'
    });
    expect(authorizations).toEqual([
      'Bearer host-token-for-com.example.one',
      'Bearer host-token-for-com.example.one',
      'Bearer host-token-for-com.example.two'
    ]);
  });

  it('verifies notifications of every listed app and rejects any other app, whatever the unsigned body claims', async () => {
    const provider = createAppleProvider({ bundleIds, appStoreServerApiKey });
    for (const bundleId of bundleIds) {
      await expect(provider.parseWebhook!(webhook(signJws(sampleSubscribedNotification(chain, { bundleId }), chain)))).resolves.toEqual([
        expect.objectContaining({ signatureVerified: true, providerSubscriptionId: '12345' })
      ]);
    }
    const signedPayload = signJws(sampleSubscribedNotification(chain, { bundleId: 'com.example.other' }), chain);
    const rawBody = JSON.stringify({ signedPayload, bundleId: 'com.example.one', data: { bundleId: 'com.example.one' } });
    await expect(provider.parseWebhook!({ headers: {}, rawBody } as never)).rejects.toMatchObject({
      code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID',
      details: { reason: 'bundle_id_mismatch' }
    });
  });

  it("pages each app's notification history in turn, with a token for that app", async () => {
    const notification = (bundleId: string) => ({
      signedPayload: signJws({ ...sampleSubscribedNotification(chain, { bundleId }), notificationUUID: `uuid-${bundleId}` }, chain)
    });
    const requests: Array<{ bid: string; paginationToken: string | null }> = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { bid } = claimsOf(init);
      const paginationToken = new URL(String(url)).searchParams.get('paginationToken');
      requests.push({ bid, paginationToken });
      const more = bid === 'com.example.one' && paginationToken === null;
      return Response.json({ notificationHistory: [notification(bid)], ...(more ? { paginationToken: 'one-page-2' } : {}) });
    });
    const provider = createAppleProvider({ bundleIds, appStoreServerApiKey, fetch: fetchMock as typeof fetch });
    const events: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await provider.fetchNotificationHistory!({ cursor, limit: 20 });
      events.push(...result.events.map((event) => event.providerEventId));
      cursor = result.nextCursor;
      if (!cursor) {
        break;
      }
    }
    expect(requests).toEqual([
      { bid: 'com.example.one', paginationToken: null },
      { bid: 'com.example.one', paginationToken: 'one-page-2' },
      { bid: 'com.example.two', paginationToken: null }
    ]);
    expect(events).toEqual(['uuid-com.example.one', 'uuid-com.example.one', 'uuid-com.example.two']);
    expect(cursor).toBeUndefined();
  });

  describe('notification history cursors written before the bundle IDs changed', () => {
    const historyCursor = (position: { bundleId: string; paginationToken?: string }) =>
      `billfn-apple-history:${Buffer.from(JSON.stringify(position)).toString('base64url')}`;

    /** Reads one history page with the given bundle IDs and reports the request Apple received and the next cursor. */
    async function readPage(configured: { bundleId?: string; bundleIds?: string[] }, cursor: string, more = false) {
      const requests: Array<{ bid: string; paginationToken: string | null }> = [];
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ bid: claimsOf(init).bid, paginationToken: new URL(String(url)).searchParams.get('paginationToken') });
        return Response.json({ notificationHistory: [], ...(more ? { paginationToken: 'next-page' } : {}) });
      });
      const provider = createAppleProvider({ ...configured, appStoreServerApiKey, fetch: fetchMock as typeof fetch });
      const { nextCursor } = await provider.fetchNotificationHistory!({ cursor });
      return { requests, nextCursor };
    }

    it("reads Apple's own pagination token as the first app's", async () => {
      await expect(readPage({ bundleIds }, 'legacy-page')).resolves.toEqual({
        requests: [{ bid: 'com.example.one', paginationToken: 'legacy-page' }],
        nextCursor: historyCursor({ bundleId: 'com.example.two' })
      });
    });

    it('continues a kept app after narrowing to one bundle ID, and returns plain Apple tokens from then on', async () => {
      await expect(readPage({ bundleId: 'com.example.two' }, historyCursor({ bundleId: 'com.example.two', paginationToken: 'two-page-3' }), true))
        .resolves.toEqual({ requests: [{ bid: 'com.example.two', paginationToken: 'two-page-3' }], nextCursor: 'next-page' });
      await expect(readPage({ bundleIds: ['com.example.two'] }, historyCursor({ bundleId: 'com.example.two' }))).resolves.toEqual({
        requests: [{ bid: 'com.example.two', paginationToken: null }],
        nextCursor: undefined
      });
    });

    it('restarts from the first listed app when the cursor names a removed app, instead of failing every backfill', async () => {
      const removed = historyCursor({ bundleId: 'com.example.removed', paginationToken: 'removed-page-2' });
      await expect(readPage({ bundleId: 'com.example.one' }, removed, true)).resolves.toEqual({
        requests: [{ bid: 'com.example.one', paginationToken: null }],
        nextCursor: 'next-page'
      });
      await expect(readPage({ bundleIds }, removed)).resolves.toEqual({
        requests: [{ bid: 'com.example.one', paginationToken: null }],
        nextCursor: historyCursor({ bundleId: 'com.example.two' })
      });
    });

    describe("Apple's hasMore flag", () => {
      /** Reads one page of a multi-app history whose answer carries a token and the given hasMore flag. */
      async function readFlaggedPage(cursor: string, hasMore: boolean, configured: { bundleId?: string; bundleIds?: string[] } = { bundleIds }) {
        const fetchMock = vi.fn(async () => Response.json({ notificationHistory: [], paginationToken: 'stale-page', hasMore }));
        const provider = createAppleProvider({ ...configured, appStoreServerApiKey, fetch: fetchMock as typeof fetch });
        return (await provider.fetchNotificationHistory!({ cursor })).nextCursor;
      }

      it("moves to the next app when Apple says the app has no more history, even with a token", async () => {
        await expect(readFlaggedPage(historyCursor({ bundleId: 'com.example.one', paginationToken: 'one-page-2' }), false))
          .resolves.toBe(historyCursor({ bundleId: 'com.example.two' }));
      });

      it('ends the history after the last app when Apple says it has no more, even with a token', async () => {
        await expect(readFlaggedPage(historyCursor({ bundleId: 'com.example.two' }), false)).resolves.toBeUndefined();
      });

      it('continues the same app while Apple says it has more', async () => {
        await expect(readFlaggedPage(historyCursor({ bundleId: 'com.example.one' }), true))
          .resolves.toBe(historyCursor({ bundleId: 'com.example.one', paginationToken: 'stale-page' }));
      });

      it('leaves single-app cursors as plain Apple tokens', async () => {
        await expect(readFlaggedPage('one-page-2', false, { bundleId: 'com.example.one' })).resolves.toBe('stale-page');
      });
    });

    it('rejects a malformed adapter cursor without asking Apple', async () => {
      for (const configured of [{ bundleIds }, { bundleId: 'com.example.one' }]) {
        for (const cursor of [
          'billfn-apple-history:not-json',
          'billfn-apple-history:not*base64url',
          'billfn-apple-history:abcde',
          `billfn-apple-history:${Buffer.from([0xff, 0xfe, 0x7b]).toString('base64url')}`,
          historyCursor({ bundleId: '' }),
          historyCursor({ bundleId: 'com.example.one', paginationToken: '' })
        ]) {
          await expect(readPage(configured, cursor)).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
        }
      }
    });

    it('reads and writes cursors without Node Buffer, as on Workers', async () => {
      const cursor = historyCursor({ bundleId: 'com.example.one', paginationToken: 'one-page-2' });
      const expectedNextCursor = historyCursor({ bundleId: 'com.example.two' });
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        // Node's own Response reads its body through Buffer, so the stand-in answers with text alone.
        return { ok: true, status: 200, text: async () => JSON.stringify({ notificationHistory: [] }) } as Response;
      });
      const provider = createAppleProvider({ bundleIds, appStoreServerApiKey, fetch: fetchMock as typeof fetch });
      // Vitest's own worker IPC needs a working Buffer while the request is awaited, so Buffer is not removed.
      // A stand-in forwards every static call to the real Buffer and records the ones made from adapter source.
      const realBuffer = globalThis.Buffer;
      const adapterBufferCalls: string[] = [];
      const recordingBuffer = new Proxy(realBuffer, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function' || property === 'prototype' || property === 'constructor') return value;
          return (...args: unknown[]) => {
            const callers = (new Error().stack ?? '').split('\n').slice(2);
            if (callers.some((frame) => /provider-apple[\\/]src[\\/](?!__tests__)/.test(frame))) {
              adapterBufferCalls.push(`Buffer.${String(property)}`);
            }
            return Reflect.apply(value, target, args);
          };
        }
      });
      vi.stubGlobal('Buffer', recordingBuffer);
      let nextCursor: string | undefined;
      try {
        ({ nextCursor } = await provider.fetchNotificationHistory!({ cursor }));
      } finally {
        vi.unstubAllGlobals();
      }
      expect(adapterBufferCalls).toEqual([]);
      expect(nextCursor).toBe(expectedNextCursor);
      expect(calls.map(({ url, init }) => ({ bid: claimsOf(init).bid, paginationToken: new URL(url).searchParams.get('paginationToken') })))
        .toEqual([{ bid: 'com.example.one', paginationToken: 'one-page-2' }]);
    });
  });

  it('names bundleIds as an alternative to bundleId in the configuration errors', () => {
    expect(() => createAppleProvider({})).toThrow(/bundleIds in place of bundleId/);
    expect(() => createAppleProvider({ appStoreServerApiKey })).toThrow(/only with a bundleId or bundleIds/);
  });

  it('requires a non-empty list of non-empty bundle IDs', () => {
    expect(() => createAppleProvider({ bundleIds: [], appStoreServerApiKey })).toThrow(/bundleIds must be a non-empty array/);
    expect(() => createAppleProvider({ bundleIds: ['com.example', ' '], appStoreServerApiKey })).toThrow(/bundleIds entry/);
    expect(() => createAppleProvider({ bundleIds: ['com.example'], appStoreServerApiKey })).not.toThrow();
  });
});

describe('createAppleProvider binds each price to its app with several bundle IDs', () => {
  const bundleIds = ['com.example.one', 'com.example.two'];
  /** Product IDs are unique only within an app, so both apps sell the same one. */
  const productId = 'com.example.shared-product';
  /** Each app's transaction; StoreKit answers not-found to a token for any other app. */
  const transactionOf: Record<string, string> = { 'com.example.one': 'txn_one', 'com.example.two': 'txn_two' };
  const appAccountTokenPromise = createAppleProvider({ bundleId: 'com.example.one', appStoreServerApiKey })
    .createCheckout!({ billingAccount: { id: 'acct_1' }, price: { providerProductId: productId } } as never)
    .then((checkout) => String(checkout.clientAction?.metadata?.appAccountToken));

  const bidOf = (init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>).authorization).replace(/^Bearer /, '');
    return (JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { bid: string }).bid;
  };
  const signedTransaction = (bundleId: string, appAccountToken: string) =>
    signJws(
      {
        transactionId: transactionOf[bundleId],
        originalTransactionId: transactionOf[bundleId],
        bundleId,
        productId,
        appAccountToken,
        purchaseDate: 1698148800000,
        expiresDate: 4102444800000,
        environment: 'Production'
      },
      chain
    );

  /**
   * A StoreKit double for both apps; `answerAs` makes it answer with another app's transaction, as a forged answer, and
   * `config` adds to (or replaces the fetch of) the provider's configuration.
   */
  async function storeKit(answerAs?: string, config: Record<string, unknown> = {}) {
    const appAccountToken = await appAccountTokenPromise;
    const bids: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const bid = bidOf(init);
      bids.push(bid);
      const owner = answerAs ?? Object.keys(transactionOf).find((bundleId) => String(url).endsWith(`/${transactionOf[bundleId]}`));
      if (!answerAs && owner !== bid) {
        return Response.json({ errorCode: 4040010 }, { status: 404 });
      }
      const signed = signedTransaction(owner!, appAccountToken);
      return String(url).includes('/inApps/v2/history/')
        ? Response.json({ signedTransactions: [signed] })
        : Response.json({ data: [{ lastTransactions: [{ originalTransactionId: transactionOf[owner!], status: 1, signedTransactionInfo: signed }] }] });
    });
    return { bids, provider: createAppleProvider({ bundleIds, appStoreServerApiKey, fetch: fetchMock as typeof fetch, ...config }) };
  }

  const priceFor = (kind: 'subscription' | 'one_time', metadata?: Record<string, unknown>) =>
    ({ priceId: `price-${kind}`, provider: 'apple', kind, providerProductId: productId, ...(metadata ? { metadata } : {}) }) as never;
  const boundToOne = (kind: 'subscription' | 'one_time') => priceFor(kind, { appleBundleId: 'com.example.one' });

  const operations = {
    verifyCheckout: (provider: Awaited<ReturnType<typeof storeKit>>['provider'], price: never, reference: string) =>
      provider.verifyCheckout!({ billingAccount: { id: 'acct_1' }, price, payload: { transactionId: reference, bundleId: 'com.example.one' } } as never),
    restorePurchases: (provider: Awaited<ReturnType<typeof storeKit>>['provider'], price: never, reference: string) =>
      provider.restorePurchases!({ billingAccount: { id: 'acct_1' }, price, purchaseReference: reference } as never).then(([state]) => state)
  };

  describe.each(['subscription', 'one_time'] as const)('a %s price', (kind) => {
    describe.each(Object.keys(operations) as Array<keyof typeof operations>)('%s', (operation) => {
      it("accepts the price's own app's transaction, asking only that app", async () => {
        const { bids, provider } = await storeKit();
        await expect(operations[operation](provider, boundToOne(kind), 'txn_one')).resolves.toMatchObject({
          providerChargeId: 'txn_one',
          providerProductId: productId
        });
        expect(new Set(bids)).toEqual(new Set(['com.example.one']));
      });

      it("rejects another listed app's transaction with the same product and billing account", async () => {
        const { bids, provider } = await storeKit();
        await expect(operations[operation](provider, boundToOne(kind), 'txn_two')).rejects.toMatchObject({
          code: 'BILLFN_PROVIDER_ERROR',
          details: { status: 404 }
        });
        expect(new Set(bids)).toEqual(new Set(['com.example.one']));
      });

      it("rejects an answer whose signed transaction names another app than the price's", async () => {
        const { provider } = await storeKit('com.example.two');
        await expect(operations[operation](provider, boundToOne(kind), 'txn_two')).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
      });

      it('rejects a price that names no app, or an app that is not listed, without asking Apple', async () => {
        const { bids, provider } = await storeKit();
        for (const price of [priceFor(kind), priceFor(kind, { appleBundleId: 'com.example.other' }), priceFor(kind, { appleBundleId: 1 })]) {
          await expect(operations[operation](provider, price, 'txn_one')).rejects.toMatchObject({
            code: 'BILLFN_VALIDATION_ERROR',
            message: expect.stringContaining('metadata.appleBundleId')
          });
        }
        expect(bids).toEqual([]);
      });
    });
  });

  describe('fetchSubscription', () => {
    const subscription = (reference: string, metadata?: Record<string, unknown>) =>
      ({ billingAccountId: 'acct_1', providerSubscriptionId: reference, ...(metadata ? { metadata } : {}) }) as never;

    it("keeps syncing a subscription BillFn moved to another app's price of the same product, as after a plan change", async () => {
      const { bids, provider } = await storeKit();
      // BillFn picks a price by product alone, so app two's subscription can arrive with app one's price of that product.
      await expect(provider.fetchSubscription!({ subscription: subscription('txn_two'), price: boundToOne('subscription') } as never)).resolves.toMatchObject({
        providerSubscriptionId: 'txn_two',
        providerProductId: productId,
        subscriptionStatus: 'active'
      });
      expect(bids.at(-1)).toBe('com.example.two');
      await expect(provider.fetchSubscription!({ subscription: subscription('txn_one'), price: priceFor('subscription') } as never)).resolves.toMatchObject({
        providerSubscriptionId: 'txn_one'
      });
    });

    it("still requires the billing account's token on a synced subscription", async () => {
      const { provider } = await storeKit();
      const otherAccount = { billingAccountId: 'acct_2', providerSubscriptionId: 'txn_two' } as never;
      await expect(provider.fetchSubscription!({ subscription: otherAccount, price: boundToOne('subscription') } as never)).rejects.toMatchObject({
        code: 'BILLFN_CONFLICT'
      });
    });

    it('finds an imported subscription in whichever listed app owns it, as the operator bound it', async () => {
      const { bids, provider } = await storeKit();
      const imported = subscription('txn_two', { billfnImportedAt: '2026-11-19T00:00:00.000Z' });
      await expect(provider.fetchSubscription!({ subscription: imported, price: boundToOne('subscription') } as never)).resolves.toMatchObject({
        providerSubscriptionId: 'txn_two'
      });
      expect(bids.at(-1)).toBe('com.example.two');
    });
  });

  describe('with the catalog, a product ID the two apps sell in different plans', () => {
    /** Basic is app one's only plan; each app sells the shared product in its own pro plan, so an upgrade is ambiguous by product. */
    const applePrice = (priceId: string, providerProductId: string, appleBundleId?: string) => ({
      priceId,
      provider: 'apple',
      kind: 'subscription',
      providerProductId,
      ...(appleBundleId ? { metadata: { appleBundleId } } : {})
    });
    const plan = (planKey: string, ...prices: Array<ReturnType<typeof applePrice>>) => ({ planKey, prices });
    const catalog = {
      plans: [
        plan('basic', applePrice('basic-one', 'com.example.basic', 'com.example.one')),
        plan('pro-one', applePrice('pro-one', productId, 'com.example.one')),
        plan('pro-two', applePrice('pro-two', productId, 'com.example.two'))
      ]
    } as never;

    const catalogProvider = async (config: Record<string, unknown> = {}) => (await storeKit(undefined, { catalog, ...config })).provider;
    const renewal = (bundleId: string) => {
      const notification = sampleSubscribedNotification(chain, { bundleId });
      const data = notification.data as Record<string, unknown>;
      return {
        ...notification,
        notificationType: 'DID_RENEW',
        subtype: undefined,
        notificationUUID: `renew-${bundleId}`,
        data: { ...data, signedTransactionInfo: signedTransaction(bundleId, 'test-app-account-token') }
      };
    };

    it('names the price of the app that signed a webhook notification', async () => {
      const provider = await catalogProvider();
      for (const [bundleId, priceId] of [['com.example.one', 'pro-one'], ['com.example.two', 'pro-two']]) {
        await expect(provider.parseWebhook!(webhook(signJws(renewal(bundleId), chain)))).resolves.toEqual([
          expect.objectContaining({ priceId, billingState: expect.objectContaining({ providerProductId: productId }) })
        ]);
      }
    });

    it("names the price of each history notification's app", async () => {
      const fetchMock = vi.fn(async () =>
        Response.json({ notificationHistory: [{ signedPayload: signJws(renewal('com.example.two'), chain) }], hasMore: false })
      ) as typeof fetch;
      const provider = await catalogProvider({ fetch: fetchMock });
      const page = await provider.fetchNotificationHistory!({ limit: 10 });
      expect(page.events).toEqual([expect.objectContaining({ priceId: 'pro-two' })]);
    });

    it("names the subscription's own app's price on a sync, whichever app's price of the product it is read for", async () => {
      // After an upgrade BillFn reads the subscription for the event's price (its sync candidate), which may be either app's.
      const provider = await catalogProvider();
      for (const [reference, priceId] of [['txn_one', 'pro-one'], ['txn_two', 'pro-two']]) {
        for (const price of [applePrice('pro-one', productId, 'com.example.one'), applePrice('pro-two', productId, 'com.example.two')]) {
          const state = await provider.fetchSubscription!({
            subscription: { billingAccountId: 'acct_1', providerSubscriptionId: reference },
            price
          } as never);
          expect(state).toMatchObject({ providerProductId: productId, raw: { priceId } });
        }
      }
    });

    it('names the verified, restored or imported transaction\'s own price', async () => {
      const provider = await catalogProvider();
      const proOne = applePrice('pro-one', productId, 'com.example.one') as never;
      await expect(operations.verifyCheckout(provider as never, proOne, 'txn_one')).resolves.toMatchObject({ raw: { priceId: 'pro-one' } });
      await expect(operations.restorePurchases(provider as never, proOne, 'txn_one')).resolves.toMatchObject({ raw: { priceId: 'pro-one' } });
      await expect(provider.importSubscription!({ providerReference: 'txn_two' } as never)).resolves.toMatchObject({ raw: { priceId: 'pro-two' } });
    });

    it('leaves a product sold in one plan to BillFn\'s product match, as without a catalog', async () => {
      const onePlan = { plans: [plan('pro', applePrice('pro-one', productId, 'com.example.one'), applePrice('pro-two', productId, 'com.example.two'))] } as never;
      const provider = await catalogProvider({ catalog: onePlan });
      const [event] = await provider.parseWebhook!(webhook(signJws(renewal('com.example.two'), chain)));
      expect(event.priceId).toBe(productId);
      const state = await provider.fetchSubscription!({
        subscription: { billingAccountId: 'acct_1', providerSubscriptionId: 'txn_two' },
        price: applePrice('pro-one', productId, 'com.example.one')
      } as never);
      expect(state?.raw).not.toHaveProperty('priceId');
    });

    it('rejects a catalog with an Apple price that names no listed app', () => {
      for (const appleBundleId of [undefined, 'com.example.other']) {
        const unbound = { plans: [plan('pro', applePrice('pro', productId, appleBundleId))] } as never;
        expect(() => createAppleProvider({ bundleIds, appStoreServerApiKey, catalog: unbound })).toThrow(
          expect.objectContaining({ code: 'BILLFN_VALIDATION_ERROR', message: expect.stringContaining('metadata.appleBundleId') })
        );
      }
    });
  });

  it('rejects a checkout for a price that names no listed app', async () => {
    const { provider } = await storeKit();
    await expect(provider.createCheckout!({ billingAccount: { id: 'acct_1' }, price: priceFor('subscription') } as never)).rejects.toMatchObject({
      code: 'BILLFN_VALIDATION_ERROR'
    });
    await expect(provider.createCheckout!({ billingAccount: { id: 'acct_1' }, price: boundToOne('subscription') } as never)).resolves.toMatchObject({
      status: 'requires_action'
    });
  });

  it('with one bundle ID, checks a price that names its app and keeps accepting a price that names none', async () => {
    const appAccountToken = await appAccountTokenPromise;
    const fetchMock = vi.fn(async () => Response.json({ signedTransactions: [signedTransaction('com.example.one', appAccountToken)] }));
    const provider = createAppleProvider({ bundleId: 'com.example.one', appStoreServerApiKey, fetch: fetchMock as typeof fetch });
    const verify = (price: never) =>
      provider.verifyCheckout!({ billingAccount: { id: 'acct_1' }, price, payload: { transactionId: 'txn_one' } } as never);
    await expect(verify(priceFor('one_time'))).resolves.toMatchObject({ providerChargeId: 'txn_one' });
    await expect(verify(boundToOne('one_time'))).resolves.toMatchObject({ providerChargeId: 'txn_one' });
    await expect(verify(priceFor('one_time', { appleBundleId: 'com.example.two' }))).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
  });
});
