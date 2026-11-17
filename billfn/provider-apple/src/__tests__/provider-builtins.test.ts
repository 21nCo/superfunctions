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
