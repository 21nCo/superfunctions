import { describe, expect, it, vi } from 'vitest';
import { createAppleProvider } from '../index.js';

// Golden vectors keep the billing-account mapping stable without duplicating its implementation.
const USER_APP_ACCOUNT_TOKEN = ['a727af00', '9265', '52ac', 'a07b', '56be001cdbb7'].join('-');
const OTHER_APP_ACCOUNT_TOKEN = ['d4d32fe2', 'cc28', '51ad', '8443', '6b8b1931780d'].join('-');

function encodePayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('@billfn/provider-apple', () => {
  it('maps subscription verification responses to normalized billfn state with prod-to-sandbox fallback', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const value = new URL(String(url));
      if (value.hostname === 'api.storekit.itunes.apple.com') {
        return new Response(JSON.stringify({ errorCode: 4040010, errorMessage: 'Transaction id not found.' }), {
          status: 404
        });
      }
      return new Response(
        JSON.stringify({
          data: [
            {
              lastTransactions: [
                {
                  signedTransactionInfo: encodePayload({
                    originalTransactionId: 'orig_other',
                    transactionId: 'txn_other',
                    productId: 'apple.other.month',
                    appAccountToken: OTHER_APP_ACCOUNT_TOKEN,
                    purchaseDate: Date.parse('2026-04-01T00:00:00.000Z'),
                    expiresDate: Date.parse('2026-06-01T00:00:00.000Z')
                  }),
                  status: 1
                },
                {
                  signedTransactionInfo: encodePayload({
                    originalTransactionId: 'orig_123',
                    transactionId: 'txn_123',
                    productId: 'apple.pro.month',
                    appAccountToken: USER_APP_ACCOUNT_TOKEN,
                    purchaseDate: Date.parse('2026-04-20T00:00:00.000Z'),
                    expiresDate: Date.parse('2026-05-20T00:00:00.000Z')
                  }),
                  signedRenewalInfo: encodePayload({
                    autoRenewStatus: 1
                  }),
                  status: 2
                }
              ]
            }
          ]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      );
    }) as typeof fetch;

    const provider = createAppleProvider({
      fetch: fetchMock,
      tokenProvider: async () => 'token'
    });

    const verified = await provider.verifyCheckout?.({
      checkoutSession: {
        checkoutSessionId: 'chk_123',
        billingAccountId: 'ba_user_123',
        planKey: 'pro',
        priceId: 'price_apple',
        provider: 'apple',
        status: 'requires_action',
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      },
      billingAccount: {
        id: 'ba_user_123',
        ownerType: 'user',
        ownerId: 'user_123',
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      },
      plan: {
        productKey: 'nucleus',
        planKey: 'pro',
        displayName: 'Pro',
        features: {},
        limits: {},
        prices: []
      },
      price: {
        priceId: 'price_apple',
        provider: 'apple',
        providerProductId: 'apple.pro.month',
        amount: 12,
        currency: 'USD',
        interval: 'month',
        kind: 'subscription'
      },
      payload: {
        transactionId: 'txn_123'
      }
    });

    expect(verified?.subscriptionStatus).toBe('expired');
    expect(verified?.providerChargeId).toBe('txn_123');
    // The product is only inside the signed transaction, so the state names it for BillFn core.
    expect(verified?.providerProductId).toBe('apple.pro.month');
    expect(verified?.currentPeriodStart).toBe('2026-04-20T00:00:00.000Z');
    expect(verified?.currentPeriodEnd).toBe('2026-05-20T00:00:00.000Z');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/txn_123');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('https://api.storekit-sandbox.itunes.apple.com/inApps/v1/subscriptions/txn_123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a stable StoreKit app account token in the purchase client action', async () => {
    const provider = createAppleProvider({
      tokenProvider: async () => 'token'
    });

    const result = await provider.createCheckout?.({
      checkoutSessionId: 'chk_123',
      billingAccount: {
        id: 'ba_user_123',
        ownerType: 'user',
        ownerId: 'user_123',
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      },
      plan: {
        productKey: 'nucleus',
        planKey: 'pro',
        displayName: 'Pro',
        features: {},
        limits: {},
        prices: []
      },
      price: {
        priceId: 'price_apple',
        provider: 'apple',
        providerProductId: 'apple.pro.month',
        amount: 12,
        currency: 'USD',
        interval: 'month',
        kind: 'subscription'
      }
    });

    expect(result?.clientAction).toMatchObject({
      type: 'apple-purchase',
      productId: 'apple.pro.month',
      metadata: { appAccountToken: USER_APP_ACCOUNT_TOKEN }
    });
  });

  it('does not fall back to sandbox when production auth fails', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
    const provider = createAppleProvider({
      fetch: fetchMock,
      tokenProvider: async () => 'expired-token'
    });

    await expect(
      provider.verifyCheckout?.({
        checkoutSession: {
          checkoutSessionId: 'chk_123',
          billingAccountId: 'ba_user_123',
          planKey: 'pro',
          priceId: 'price_apple',
          provider: 'apple',
          status: 'requires_action',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z'
        },
        billingAccount: {
          id: 'ba_user_123',
          ownerType: 'user',
          ownerId: 'user_123',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z'
        },
        plan: {
          productKey: 'nucleus',
          planKey: 'pro',
          displayName: 'Pro',
          features: {},
          limits: {},
          prices: []
        },
        price: {
          priceId: 'price_apple',
          provider: 'apple',
          providerProductId: 'apple.pro.month',
          amount: 12,
          currency: 'USD',
          interval: 'month',
          kind: 'subscription'
        },
        payload: {
          transactionId: 'txn_123'
        }
      })
    ).rejects.toMatchObject({
      code: 'BILLFN_PROVIDER_ERROR'
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to sandbox for unrelated production request errors', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ errorCode: 4040002, errorMessage: 'Account not found. Please try again.' }),
      { status: 404 }
    )) as typeof fetch;
    const provider = createAppleProvider({
      fetch: fetchMock,
      tokenProvider: async () => 'token'
    });

    await expect(
      provider.verifyCheckout?.({
        checkoutSession: {
          checkoutSessionId: 'chk_bad_request',
          billingAccountId: 'ba_user_123',
          planKey: 'pro',
          priceId: 'price_apple',
          provider: 'apple',
          status: 'requires_action',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z'
        },
        billingAccount: {
          id: 'ba_user_123',
          ownerType: 'user',
          ownerId: 'user_123',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z'
        },
        plan: {
          productKey: 'nucleus',
          planKey: 'pro',
          displayName: 'Pro',
          features: {},
          limits: {},
          prices: []
        },
        price: {
          priceId: 'price_apple',
          provider: 'apple',
          providerProductId: 'apple.pro.month',
          amount: 12,
          currency: 'USD',
          interval: 'month',
          kind: 'subscription'
        },
        payload: { transactionId: 'malformed' }
      })
    ).rejects.toMatchObject({ code: 'BILLFN_PROVIDER_ERROR' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects empty subscription responses instead of marking them active', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    const provider = createAppleProvider({
      fetch: fetchMock,
      tokenProvider: async () => 'token'
    });

    await expect(provider.fetchSubscription?.({
      subscription: {
        id: 'sub_local',
        billingAccountId: 'ba_user_123',
        planKey: 'pro',
        priceId: 'price_apple',
        provider: 'apple',
        providerSubscriptionId: 'orig_123',
        status: 'active',
        autoRenew: true,
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      },
      plan: {
        productKey: 'nucleus',
        planKey: 'pro',
        displayName: 'Pro',
        features: {},
        limits: {},
        prices: []
      },
      price: {
        priceId: 'price_apple',
        provider: 'apple',
        providerProductId: 'apple.pro.month',
        amount: 12,
        currency: 'USD',
        interval: 'month',
        kind: 'subscription'
      }
    })).rejects.toMatchObject({
      code: 'BILLFN_NOT_FOUND'
    });
  });

  it('uses the subscriptions endpoint when restoring Apple subscription purchases', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              lastTransactions: [
                {
                  signedTransactionInfo: encodePayload({
                    originalTransactionId: 'orig_restore',
                    transactionId: 'txn_restore',
                    productId: 'apple.pro.month',
                    appAccountToken: USER_APP_ACCOUNT_TOKEN,
                    purchaseDate: Date.parse('2026-04-20T00:00:00.000Z'),
                    expiresDate: Date.parse('2026-05-20T00:00:00.000Z'),
                    status: 1
                  })
                }
              ]
            }
          ]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    ) as typeof fetch;

    const provider = createAppleProvider({
      fetch: fetchMock,
      tokenProvider: async () => 'token'
    });

    const restored = await provider.restorePurchases?.({
      billingAccount: {
        id: 'ba_user_123',
        ownerType: 'user',
        ownerId: 'user_123',
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      },
      plan: {
        productKey: 'nucleus',
        planKey: 'pro',
        displayName: 'Pro',
        features: {},
        limits: {},
        prices: []
      },
      price: {
        priceId: 'price_apple',
        provider: 'apple',
        providerProductId: 'apple.pro.month',
        amount: 12,
        currency: 'USD',
        interval: 'month',
        kind: 'subscription'
      },
      purchaseReference: 'orig_restore'
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/inApps/v1/subscriptions/orig_restore');
    expect(restored?.[0]?.subscriptionStatus).toBe('active');
    expect(restored?.[0]?.providerProductId).toBe('apple.pro.month');
  });

  it('uses the v2 history endpoint for non-subscription purchase restoration', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          signedTransactions: [
            encodePayload({
              originalTransactionId: 'orig_lifetime',
              transactionId: 'txn_lifetime',
              productId: 'apple.lifetime',
              appAccountToken: USER_APP_ACCOUNT_TOKEN,
              purchaseDate: Date.parse('2026-04-20T00:00:00.000Z')
            })
          ]
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    ) as typeof fetch;

    const provider = createAppleProvider({
      fetch: fetchMock,
      tokenProvider: async () => 'token'
    });

    const restored = await provider.restorePurchases?.({
      billingAccount: {
        id: 'ba_user_123',
        ownerType: 'user',
        ownerId: 'user_123',
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      },
      plan: {
        productKey: 'nucleus',
        planKey: 'lifetime',
        displayName: 'Lifetime',
        features: {},
        limits: {},
        prices: []
      },
      price: {
        priceId: 'price_lifetime',
        provider: 'apple',
        providerProductId: 'apple.lifetime',
        amount: 120,
        currency: 'USD',
        kind: 'one_time',
        interval: 'lifetime'
      },
      purchaseReference: 'txn_lifetime'
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/inApps/v2/history/txn_lifetime');
    expect(restored?.[0]?.providerProductId).toBe('apple.lifetime');
  });

  it('parses App Store Server Notifications v2 payloads using the configured verifier', async () => {
    const provider = createAppleProvider({
      tokenProvider: async () => 'token',
      notificationVerifier: async () => ({
        notificationUUID: 'notif_123',
        notificationType: 'DID_RENEW',
        signedDate: Date.parse('2026-04-21T00:00:00.000Z'),
        data: {
          signedTransactionInfo: encodePayload({
            originalTransactionId: 'orig_123',
            transactionId: 'txn_123',
            productId: 'apple.pro.month',
            appAccountToken: USER_APP_ACCOUNT_TOKEN,
            purchaseDate: Date.parse('2026-04-20T00:00:00.000Z'),
            expiresDate: Date.parse('2026-05-20T00:00:00.000Z'),
            status: 1
          }),
          signedRenewalInfo: encodePayload({
            autoRenewStatus: 1
          })
        }
      })
    });

    const events = await provider.parseWebhook?.({
      headers: new Headers(),
      rawBody: JSON.stringify({
        signedPayload: 'signed'
      })
    });

    expect(events).toHaveLength(1);
    expect(events?.[0]?.signatureVerified).toBe(true);
    expect(events?.[0]?.billingState?.subscriptionStatus).toBe('active');
    expect(events?.[0]?.billingState?.providerProductId).toBe('apple.pro.month');
    expect(events?.[0]?.occurredAt).toBe('2026-04-21T00:00:00.000Z');
  });

  it('returns manage-subscription actions when Advanced Commerce is unavailable', async () => {
    const provider = createAppleProvider({
      tokenProvider: async () => 'token'
    });

    const response = await provider.cancelSubscription?.({
      subscription: {
        id: 'sub_local',
        billingAccountId: 'ba_user_123',
        planKey: 'pro',
        priceId: 'price_apple',
        provider: 'apple',
        providerSubscriptionId: 'orig_123',
        providerChargeId: 'txn_123',
        status: 'active',
        autoRenew: true,
        createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      }
    });

    expect(response?.operationStatus).toBe('requires_action');
    expect(response?.clientAction?.type).toBe('manage-subscription');
  });

  it('fetches notification history and maps events', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          notificationHistory: [
            {
              signedPayload: encodePayload({
                notificationUUID: 'notif_history',
                notificationType: 'EXPIRED',
                signedDate: Date.parse('2026-05-21T00:00:00.000Z'),
                data: {
                  signedTransactionInfo: encodePayload({
                    originalTransactionId: 'orig_history',
                    transactionId: 'txn_history',
                    productId: 'apple.pro.month',
                    appAccountToken: USER_APP_ACCOUNT_TOKEN,
                    purchaseDate: Date.parse('2026-04-20T00:00:00.000Z'),
                    expiresDate: Date.parse('2026-05-20T00:00:00.000Z'),
                    status: 2
                  })
                }
              })
            }
          ],
          nextPaginationToken: 'cursor_next'
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json'
          }
        }
      )
    ) as typeof fetch;

    const provider = createAppleProvider({
      fetch: fetchMock,
      tokenProvider: async () => 'token',
      notificationVerifier: async () => ({
        notificationUUID: 'notif_history',
        notificationType: 'EXPIRED',
        signedDate: Date.parse('2026-05-21T00:00:00.000Z'),
        data: {
          signedTransactionInfo: encodePayload({
            originalTransactionId: 'orig_history',
            transactionId: 'txn_history',
            productId: 'apple.pro.month',
            appAccountToken: USER_APP_ACCOUNT_TOKEN,
            purchaseDate: Date.parse('2026-04-20T00:00:00.000Z'),
            expiresDate: Date.parse('2026-05-20T00:00:00.000Z'),
            status: 2
          })
        }
      })
    });

    const page = await provider.fetchNotificationHistory?.({
      cursor: 'cursor_1',
      limit: 10
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/inApps/v1/notifications/history?paginationToken=cursor_1');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST'
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      startDate: expect.any(Number),
      endDate: expect.any(Number)
    });
    expect(page?.events).toHaveLength(1);
    expect(page?.events[0]?.billingState?.subscriptionStatus).toBe('expired');
    expect(page?.events[0]?.occurredAt).toBe('2026-05-21T00:00:00.000Z');
    expect(page?.nextCursor).toBe('cursor_next');
  });

  it('rejects signed transactions owned by a different billing account', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        data: [{
          lastTransactions: [{
            signedTransactionInfo: encodePayload({
              originalTransactionId: 'orig_123',
              transactionId: 'txn_123',
              productId: 'apple.pro.month',
              appAccountToken: OTHER_APP_ACCOUNT_TOKEN
            }),
            status: 1
          }]
        }]
      }), { status: 200 })) as typeof fetch;
    const provider = createAppleProvider({ fetch: fetchMock, tokenProvider: async () => 'token' });

    await expect(provider.verifyCheckout?.({
      checkoutSession: {
        checkoutSessionId: 'chk_123', billingAccountId: 'ba_user_123', planKey: 'pro', priceId: 'price_apple',
        provider: 'apple', status: 'requires_action', createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      },
      billingAccount: {
        id: 'ba_user_123', ownerType: 'user', ownerId: 'user_123', createdAt: '2026-04-20T00:00:00.000Z',
        updatedAt: '2026-04-20T00:00:00.000Z'
      },
      plan: { productKey: 'nucleus', planKey: 'pro', displayName: 'Pro', features: {}, limits: {}, prices: [] },
      price: {
        priceId: 'price_apple', provider: 'apple', providerProductId: 'apple.pro.month', amount: 12,
        currency: 'USD', interval: 'month', kind: 'subscription'
      },
      payload: { transactionId: 'txn_123' }
    })).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
  });

  it('fails before fetching notification history when notificationVerifier is missing', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    const provider = createAppleProvider({
      fetch: fetchMock,
      tokenProvider: async () => 'token'
    });

    expect(provider.capabilities.notificationHistory).toBe(false);
    await expect(provider.fetchNotificationHistory?.({ limit: 10 })).rejects.toMatchObject({
      code: 'BILLFN_FEATURE_UNAVAILABLE',
      message: expect.stringContaining('notificationVerifier')
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('importing a purchase made before BillFn', () => {
    // Recorded GET /inApps/v1/subscriptions/:originalTransactionId: the legacy purchase has no BillFn appAccountToken.
    const recorded = {
      environment: 'Production',
      data: [{
        subscriptionGroupIdentifier: 'nucleus',
        lastTransactions: [
          {
            originalTransactionId: 'orig_other',
            status: 1,
            signedTransactionInfo: encodePayload({
              originalTransactionId: 'orig_other',
              transactionId: 'txn_other',
              productId: 'apple.other.month',
              appAccountToken: OTHER_APP_ACCOUNT_TOKEN
            })
          },
          {
            originalTransactionId: 'orig_legacy',
            status: 1,
            signedTransactionInfo: encodePayload({
              originalTransactionId: 'orig_legacy',
              transactionId: 'txn_legacy_renewal',
              productId: 'apple.nucleus.year',
              purchaseDate: Date.parse('2026-06-01T00:00:00.000Z'),
              expiresDate: Date.parse('2027-06-01T00:00:00.000Z')
            }),
            signedRenewalInfo: encodePayload({ autoRenewStatus: 1 })
          }
        ]
      }]
    };
    const billingAccount = {
      id: 'ba_user_123', ownerType: 'user' as const, ownerId: 'user_123', createdAt: '2026-04-20T00:00:00.000Z',
      updatedAt: '2026-04-20T00:00:00.000Z'
    };
    const plan = { productKey: 'nucleus', planKey: 'nucleus', displayName: 'Nucleus', features: {}, limits: {}, prices: [] };
    const price = {
      priceId: 'price_apple_year', provider: 'apple' as const, providerProductId: 'apple.nucleus.year', amount: 120,
      currency: 'USD', interval: 'year' as const, kind: 'subscription' as const
    };

    function provider() {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(recorded), { status: 200 })) as typeof fetch;
      return { fetchMock, provider: createAppleProvider({ fetch: fetchMock, tokenProvider: async () => 'token' }) };
    }

    it('reads the original transaction without matching the BillFn appAccountToken', async () => {
      const { fetchMock, provider: apple } = provider();

      expect(apple.capabilities.importSubscription).toBe(true);
      await expect(apple.importSubscription?.({ providerReference: 'orig_legacy', billingAccount, plan })).resolves.toMatchObject({
        subscriptionStatus: 'active',
        providerSubscriptionId: 'orig_legacy',
        providerChargeId: 'txn_legacy_renewal',
        providerProductId: 'apple.nucleus.year',
        currentPeriodEnd: '2027-06-01T00:00:00.000Z',
        autoRenew: true
      });
      expect(String(vi.mocked(fetchMock).mock.calls[0]?.[0])).toBe(
        'https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/orig_legacy'
      );
    });

    it('rejects a renewal transaction id as invalid input, naming the original transaction id', async () => {
      // StoreKit answers for any transaction of the subscription; the import binds the original one.
      const { provider: apple } = provider();

      await expect(apple.importSubscription?.({ providerReference: 'txn_legacy_renewal', billingAccount, plan })).rejects.toMatchObject({
        code: 'BILLFN_VALIDATION_ERROR',
        retryable: false,
        details: { originalTransactionIds: ['orig_other', 'orig_legacy'] }
      });
    });

    it('reports a transaction StoreKit does not know as missing', async () => {
      // StoreKit's TransactionIdNotFoundError, answered by production and then by the sandbox fallback.
      const notFound = JSON.stringify({ errorCode: 4040010, errorMessage: 'Transaction id not found.' });
      const fetchMock = vi.fn(async () => new Response(notFound, { status: 404 })) as typeof fetch;
      const apple = createAppleProvider({ fetch: fetchMock, tokenProvider: async () => 'token' });

      await expect(apple.importSubscription?.({ providerReference: 'orig_missing', billingAccount, plan })).resolves.toBeNull();
      expect(vi.mocked(fetchMock).mock.calls.map((call) => String(call[0]))).toEqual([
        'https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/orig_missing',
        'https://api.storekit-sandbox.itunes.apple.com/inApps/v1/subscriptions/orig_missing'
      ]);

      // Any other production 404 is missing at once: only a transaction production does not know is read from the sandbox.
      const otherNotFound = JSON.stringify({ errorCode: 4040002, errorMessage: 'Account not found. Please try again.' });
      const productionOnly = vi.fn(async () => new Response(otherNotFound, { status: 404 })) as typeof fetch;
      const appleProduction = createAppleProvider({ fetch: productionOnly, tokenProvider: async () => 'token' });
      await expect(appleProduction.importSubscription?.({ providerReference: 'orig_missing', billingAccount, plan })).resolves.toBeNull();
      expect(vi.mocked(productionOnly)).toHaveBeenCalledTimes(1);

      // A response without transactions is missing too; a StoreKit outage stays a retryable provider error.
      const empty = createAppleProvider({
        fetch: vi.fn(async () => new Response(JSON.stringify({ environment: 'Production', data: [] }), { status: 200 })) as typeof fetch,
        tokenProvider: async () => 'token'
      });
      await expect(empty.importSubscription?.({ providerReference: 'orig_legacy', billingAccount, plan })).resolves.toBeNull();
      const down = createAppleProvider({
        fetch: vi.fn(async () => new Response('', { status: 500 })) as typeof fetch,
        tokenProvider: async () => 'token'
      });
      await expect(down.importSubscription?.({ providerReference: 'orig_legacy', billingAccount, plan })).rejects.toMatchObject({
        code: 'BILLFN_PROVIDER_ERROR',
        retryable: true
      });
    });

    it('syncs an imported subscription without the token check it keeps for BillFn purchases', async () => {
      const { provider: apple } = provider();
      const subscription = {
        id: 'sub_local', billingAccountId: 'ba_user_123', planKey: 'nucleus', priceId: 'price_apple_year',
        provider: 'apple' as const, providerSubscriptionId: 'orig_legacy', status: 'active' as const, autoRenew: true,
        createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z'
      };

      await expect(apple.fetchSubscription?.({ subscription, plan, price })).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
      await expect(apple.fetchSubscription?.({
        subscription: { ...subscription, metadata: { billfnImportedAt: '2026-11-10T00:00:00.000Z' } },
        plan,
        price
      })).resolves.toMatchObject({ providerSubscriptionId: 'orig_legacy', subscriptionStatus: 'active' });
      // The product is still checked for an imported subscription.
      await expect(apple.fetchSubscription?.({
        subscription: { ...subscription, metadata: { billfnImportedAt: '2026-11-10T00:00:00.000Z' } },
        plan,
        price: { ...price, providerProductId: 'apple.nucleus.month' }
      })).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
    });
  });
});
