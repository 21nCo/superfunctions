import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn, createBillFnError, createWebhookIngress, readRoutingKeys } from '../index.js';
import type {
  BillFnCatalog,
  BillFnIngressRouteDecision,
  BillFnInstance,
  BillFnProviderAdapter,
  BillFnUnlinkedWebhookEvent,
  BillFnWebhookIngressConfig
} from '../index.js';

const TOKEN = 'internal-token-for-tests';
const SIGNING_SECRET = 'dodo-signing-secret';
const REGION_IDS = ['insouth', 'useast', 'euwest'] as const;
type RegionId = (typeof REGION_IDS)[number];

const catalog: BillFnCatalog = {
  plans: [
    {
      productKey: 'nucleus',
      planKey: 'pro',
      displayName: 'Pro',
      features: { sync: true },
      limits: { storage: 1000 },
      prices: [
        {
          priceId: 'price_pro_dodo_month',
          provider: 'dodo',
          providerProductId: 'pdt_pro_month',
          currency: 'USD',
          amount: 12,
          kind: 'subscription',
          interval: 'month'
        },
        {
          priceId: 'price_pro_apple_month',
          provider: 'apple',
          providerProductId: 'com.example.pro.month',
          currency: 'USD',
          amount: 12,
          kind: 'subscription',
          interval: 'month'
        }
      ]
    }
  ]
};

function sign(body: string) {
  return createHmac('sha256', SIGNING_SECRET).update(body).digest('base64');
}

/**
 * A Dodo-shaped provider that verifies an HMAC of the exact body bytes, so a
 * forwarded request whose body or signature header changed is rejected.
 */
function createSignedDodoProvider(seenMetadata: Array<Record<string, unknown> | undefined>): BillFnProviderAdapter {
  return {
    provider: 'dodo',
    capabilities: {
      createCheckout: true,
      verifyCheckout: false,
      cancelSubscription: false,
      syncSubscription: false,
      restorePurchases: false,
      webhookIngestion: true
    },
    async createCheckout(input) {
      seenMetadata.push(input.metadata);
      return {
        status: 'pending',
        providerSubscriptionId: `sub_${input.checkoutSessionId}`,
        checkoutUrl: 'https://dodo.test/checkout'
      };
    },
    async parseWebhook({ headers, rawBody }) {
      const presented = Buffer.from(headers.get('webhook-signature') ?? '', 'base64');
      const expected = Buffer.from(sign(rawBody), 'base64');
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw createBillFnError({ code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID', message: 'bad signature' });
      }
      const payload = JSON.parse(rawBody) as { type: string; data: Record<string, string> };
      return [
        {
          providerEventId: headers.get('webhook-id') ?? 'evt',
          type: payload.type,
          signatureVerified: true,
          priceId: payload.data.product_id,
          providerSubscriptionId: payload.data.subscription_id,
          billingState: {
            subscriptionStatus: 'active',
            checkoutStatus: 'succeeded',
            providerSubscriptionId: payload.data.subscription_id,
            currentPeriodStart: '2026-11-13T00:00:00.000Z',
            currentPeriodEnd: '2026-12-13T00:00:00.000Z',
            raw: payload.data
          },
          raw: payload
        }
      ];
    }
  };
}

/** An Apple-shaped provider whose checkout returns the original transaction id; webhooks are accepted as-is. */
function createAppleProvider(originalTransactionId: string): BillFnProviderAdapter {
  return {
    provider: 'apple',
    capabilities: {
      createCheckout: true,
      verifyCheckout: false,
      cancelSubscription: false,
      syncSubscription: false,
      restorePurchases: false,
      webhookIngestion: true
    },
    async createCheckout() {
      return { status: 'pending', providerSubscriptionId: originalTransactionId };
    },
    async parseWebhook() {
      return [];
    }
  };
}

function jws(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256' })}.${encode(payload)}.signature`;
}

function appleNotification(originalTransactionId: string, transactionId: string) {
  return JSON.stringify({
    signedPayload: jws({
      notificationType: 'DID_RENEW',
      notificationUUID: `uuid_${transactionId}`,
      data: {
        signedTransactionInfo: jws({ originalTransactionId, transactionId, productId: 'com.example.pro.month' })
      }
    })
  });
}

type Region = {
  id: RegionId;
  billfn: BillFnInstance;
  db: ReturnType<typeof memoryAdapter>;
  seenMetadata: Array<Record<string, unknown> | undefined>;
  forwarded: Request[];
};

type Harness = {
  regions: Record<RegionId, Region>;
  lookups: Array<{ region: RegionId; url: URL; authorization: string | null }>;
  decisions: BillFnIngressRouteDecision[];
  ingress: ReturnType<typeof createWebhookIngress>;
};

function createHarness(
  options: {
    appleOwner?: { region: RegionId; originalTransactionId: string };
    /** Regions whose owner lookup never answers (until the ingress aborts it). */
    hangingLookups?: RegionId[];
    /** Regions whose forwarded delivery fails at the network level. */
    unreachableForward?: RegionId[];
    ingress?: Partial<BillFnWebhookIngressConfig>;
  } = {}
): Harness {
  const regions = Object.fromEntries(
    REGION_IDS.map((id) => {
      const db = memoryAdapter({ debug: false });
      const seenMetadata: Region['seenMetadata'] = [];
      const providers: Record<string, BillFnProviderAdapter> = { dodo: createSignedDodoProvider(seenMetadata) };
      if (options.appleOwner?.region === id) {
        providers.apple = createAppleProvider(options.appleOwner.originalTransactionId);
      } else {
        providers.apple = createAppleProvider(`otx_other_${id}`);
      }
      const billfn = createBillFn({ db, catalog, providers, region: { id, internalToken: TOKEN } });
      return [id, { id, billfn, db, seenMetadata, forwarded: [] }];
    })
  ) as Record<RegionId, Region>;
  const lookups: Harness['lookups'] = [];
  const decisions: Harness['decisions'] = [];

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const region = regions[url.hostname.split('.')[0] as RegionId];
    if (url.pathname === '/billfn/ops/owner') {
      lookups.push({ region: region.id, url, authorization: request.headers.get('authorization') });
      if (options.hangingLookups?.includes(region.id)) {
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
    } else {
      region.forwarded.push(request.clone());
      if (options.unreachableForward?.includes(region.id)) {
        throw new TypeError('fetch failed');
      }
    }
    return region.billfn.router.handle(request);
  };

  const ingress = createWebhookIngress({
    regions: REGION_IDS.map((id) => ({ id, url: `https://${id}.billfn.test/billfn/` })),
    defaultRegion: 'useast',
    internalToken: TOKEN,
    fetch: fetchImpl as typeof fetch,
    lookupTimeoutMs: 50,
    onRoute: (decision) => decisions.push(decision),
    ...options.ingress
  });
  return { regions, lookups, decisions, ingress };
}

async function checkout(region: Region, provider: 'dodo' | 'apple', principalId: string, metadata?: Record<string, unknown>) {
  const response = await region.billfn.createCheckout({
    subject: { principalId },
    planKey: 'pro',
    provider,
    interval: 'month',
    metadata
  });
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.data.checkoutSession;
}

function dodoEvent(subscriptionId: string, metadata?: Record<string, string>) {
  return JSON.stringify({
    type: 'subscription.active',
    data: { subscription_id: subscriptionId, product_id: 'pdt_pro_month', status: 'active', ...(metadata ? { metadata } : {}) }
  });
}

function dodoDelivery(body: string, signature = sign(body)) {
  return new Request('https://hooks.example.com/webhooks/dodo?attempt=2', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': `msg_${Math.random().toString(36).slice(2)}`,
      'webhook-timestamp': '1763251200',
      'webhook-signature': signature
    },
    body
  });
}

async function entitlementStatus(region: Region, principalId: string) {
  const response = await region.billfn.getEntitlements({ principalId });
  if (!response.ok) {
    throw new Error(response.error.message);
  }
  return response.data.entitlements?.status ?? null;
}

async function unlinkedEvents(region: Region) {
  return region.db.findMany<BillFnUnlinkedWebhookEvent>({ model: 'unlinkedWebhookEvents', namespace: 'billfn' });
}

describe('checkout region metadata', () => {
  it('writes the configured region as billfn_region, replacing a caller value', async () => {
    const { regions } = createHarness();
    const session = await checkout(regions.euwest, 'dodo', 'user_eu', { campaign: 'fall', billfn_region: 'useast' });

    expect(regions.euwest.seenMetadata).toEqual([{ campaign: 'fall', billfn_region: 'euwest' }]);
    expect(session.metadata).toMatchObject({ campaign: 'fall', billfn_region: 'euwest' });
  });

  it('drops a caller billfn_region when no region is configured', async () => {
    const seenMetadata: Array<Record<string, unknown> | undefined> = [];
    const billfn = createBillFn({
      db: memoryAdapter({ debug: false }),
      catalog,
      providers: { dodo: createSignedDodoProvider(seenMetadata) }
    });
    await billfn.createCheckout({
      subject: { principalId: 'user_single' },
      planKey: 'pro',
      provider: 'dodo',
      interval: 'month',
      metadata: { campaign: 'fall', billfn_region: 'useast' }
    });

    expect(seenMetadata).toEqual([{ campaign: 'fall' }]);
  });
});

describe('createWebhookIngress', () => {
  it('routes a Dodo event by its billfn_region metadata, forwarding body bytes and signature unchanged', async () => {
    const harness = createHarness();
    const session = await checkout(harness.regions.euwest, 'dodo', 'user_eu');
    const body = dodoEvent(session.providerSubscriptionId as string, { billfn_region: 'euwest' });
    const delivery = dodoDelivery(body);

    const response = await harness.ingress.handle('dodo', delivery.clone());

    expect(response.status).toBe(200);
    expect(harness.lookups).toEqual([]);
    expect(harness.decisions).toEqual([
      { provider: 'dodo', region: 'euwest', route: 'metadata', unreachableRegions: [] }
    ]);
    expect(harness.regions.useast.forwarded).toHaveLength(0);
    expect(harness.regions.insouth.forwarded).toHaveLength(0);
    const [forwarded] = harness.regions.euwest.forwarded;
    expect(forwarded.url).toBe('https://euwest.billfn.test/billfn/webhooks/dodo?attempt=2');
    expect(await forwarded.text()).toBe(body);
    for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature', 'content-type']) {
      expect(forwarded.headers.get(name)).toBe(delivery.headers.get(name));
    }
    expect(await entitlementStatus(harness.regions.euwest, 'user_eu')).toBe('active');
  });

  it('asks the regions which one owns a Dodo event that carries no billfn_region', async () => {
    const harness = createHarness();
    const session = await checkout(harness.regions.insouth, 'dodo', 'user_in');

    const response = await harness.ingress.handle('dodo', dodoDelivery(dodoEvent(session.providerSubscriptionId as string)));

    expect(response.status).toBe(200);
    expect(harness.decisions[0]).toMatchObject({ region: 'insouth', route: 'owner-lookup', unreachableRegions: [] });
    expect(harness.lookups.map((lookup) => lookup.authorization)).toEqual(REGION_IDS.map(() => `Bearer ${TOKEN}`));
    expect(harness.lookups[0].url.searchParams.get('provider')).toBe('dodo');
    expect(harness.lookups[0].url.searchParams.get('ref')).toBe(session.providerSubscriptionId);
    expect(harness.regions.useast.forwarded).toHaveLength(0);
    expect(await entitlementStatus(harness.regions.insouth, 'user_in')).toBe('active');
  });

  it('routes an Apple notification to the region that owns its original transaction', async () => {
    const harness = createHarness({ appleOwner: { region: 'euwest', originalTransactionId: '2000000123' } });
    await checkout(harness.regions.euwest, 'apple', 'user_apple');
    const body = appleNotification('2000000123', '2000000999');

    const response = await harness.ingress.handle(
      'apple',
      new Request('https://hooks.example.com/webhooks/apple', { method: 'POST', body })
    );

    expect(response.status).toBe(200);
    expect(harness.decisions[0]).toMatchObject({ provider: 'apple', region: 'euwest', route: 'owner-lookup' });
    expect(harness.regions.euwest.forwarded).toHaveLength(1);
    expect(await harness.regions.euwest.forwarded[0].text()).toBe(body);
    expect(new Set(harness.lookups.map((lookup) => lookup.url.searchParams.get('ref')))).toEqual(
      new Set(['2000000123', '2000000999'])
    );
  });

  it('sends an event no region owns to the default region, which stores it as unlinked', async () => {
    const harness = createHarness();

    const response = await harness.ingress.handle('dodo', dodoDelivery(dodoEvent('sub_nobody')));

    expect(response.status).toBe(200);
    expect(harness.decisions[0]).toMatchObject({ region: 'useast', route: 'default', unreachableRegions: [] });
    expect(harness.lookups).toHaveLength(REGION_IDS.length);
    expect(await unlinkedEvents(harness.regions.useast)).toEqual([
      expect.objectContaining({ provider: 'dodo', providerReference: 'sub_nobody', status: 'unlinked' })
    ]);
    expect(await unlinkedEvents(harness.regions.euwest)).toEqual([]);
  });

  it('sends an unreadable delivery to the default region without asking the regions', async () => {
    const harness = createHarness();

    const response = await harness.ingress.handle('dodo', dodoDelivery('not json', sign('forged')));

    expect(harness.lookups).toEqual([]);
    expect(harness.decisions[0]).toMatchObject({ region: 'useast', route: 'default' });
    expect(harness.regions.useast.forwarded).toHaveLength(1);
    expect(await harness.regions.useast.forwarded[0].text()).toBe('not json');
    expect(response.status).toBe(401);
  });

  it('forwards a forged event to the region it names, whose verification rejects it', async () => {
    const harness = createHarness();
    const session = await checkout(harness.regions.euwest, 'dodo', 'user_forged');
    const body = dodoEvent(session.providerSubscriptionId as string, { billfn_region: 'euwest' });

    const response = await harness.ingress.handle('dodo', dodoDelivery(body, sign('a different body')));

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('BILLFN_WEBHOOK_SIGNATURE_INVALID');
    expect(harness.regions.euwest.forwarded).toHaveLength(1);
    expect(await entitlementStatus(harness.regions.euwest, 'user_forged')).toBeNull();
  });

  it('skips a region whose owner lookup times out and routes to the owner that answers', async () => {
    const harness = createHarness({ hangingLookups: ['insouth'] });
    const session = await checkout(harness.regions.euwest, 'dodo', 'user_slow');

    const response = await harness.ingress.handle('dodo', dodoDelivery(dodoEvent(session.providerSubscriptionId as string)));

    expect(response.status).toBe(200);
    expect(harness.decisions[0]).toMatchObject({ region: 'euwest', route: 'owner-lookup', unreachableRegions: ['insouth'] });
    expect(await entitlementStatus(harness.regions.euwest, 'user_slow')).toBe('active');
  });

  it('routes to the default region when the only unanswered region times out and no other owns the event', async () => {
    const harness = createHarness({ hangingLookups: ['euwest'] });

    const response = await harness.ingress.handle('dodo', dodoDelivery(dodoEvent('sub_unknown')));

    expect(response.status).toBe(200);
    expect(harness.decisions[0]).toMatchObject({ region: 'useast', route: 'default', unreachableRegions: ['euwest'] });
    expect(await unlinkedEvents(harness.regions.useast)).toHaveLength(1);
  });

  it('asks the provider to retry when the owning region cannot be reached', async () => {
    const harness = createHarness({ unreachableForward: ['euwest'] });

    const response = await harness.ingress.handle('dodo', dodoDelivery(dodoEvent('sub_x', { billfn_region: 'euwest' })));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error).toMatchObject({ code: 'BILLFN_REGION_UNAVAILABLE', retryable: true });
    expect(harness.regions.useast.forwarded).toHaveLength(0);
  });

  it('lets resolveRegion route an event the metadata does not, before any owner lookup', async () => {
    const harness = createHarness({ ingress: { resolveRegion: ({ keys }) => (keys.references[0] === 'sub_map' ? 'insouth' : null) } });

    await harness.ingress.handle('dodo', dodoDelivery(dodoEvent('sub_map')));
    await harness.ingress.handle('dodo', dodoDelivery(dodoEvent('sub_other', { billfn_region: 'mars' })));

    expect(harness.decisions.map((decision) => [decision.region, decision.route])).toEqual([
      ['insouth', 'resolver'],
      ['useast', 'default']
    ]);
    expect(harness.lookups).toHaveLength(REGION_IDS.length);
  });

  it('rejects a configuration whose default region is not one of its regions', () => {
    expect(() =>
      createWebhookIngress({
        regions: [{ id: 'useast', url: 'https://useast.billfn.test/billfn' }],
        defaultRegion: 'euwest',
        internalToken: TOKEN
      })
    ).toThrow(/defaultRegion/);
  });
});

describe('readRoutingKeys', () => {
  it('reads Dodo metadata and references, and Apple transaction ids, ignoring malformed input', () => {
    expect(readRoutingKeys('dodo', dodoEvent('sub_1', { billfn_region: 'euwest' }))).toEqual({
      region: 'euwest',
      references: ['sub_1']
    });
    expect(readRoutingKeys('apple', appleNotification('otx', 'tx'))).toEqual({ references: ['otx', 'tx'] });
    expect(readRoutingKeys('apple', JSON.stringify({ signedPayload: 'a.%%%.c' }))).toEqual({ references: [] });
    expect(readRoutingKeys('dodo', '[1,2]')).toEqual({ references: [] });
  });
});

describe('owner lookup route', () => {
  async function lookup(billfn: BillFnInstance, query: string, authorization?: string) {
    const response = await billfn.router.handle(
      new Request(`https://useast.billfn.test/billfn/ops/owner?${query}`, {
        headers: authorization ? { authorization } : {}
      })
    );
    return { status: response.status, body: (await response.json()) as { ok: boolean; data?: unknown } };
  }

  it('requires the shared internal token', async () => {
    const { regions } = createHarness();
    const session = await checkout(regions.useast, 'dodo', 'user_lookup');
    const query = `provider=dodo&ref=${session.providerSubscriptionId}`;

    expect((await lookup(regions.useast.billfn, query)).status).toBe(401);
    expect((await lookup(regions.useast.billfn, query, 'Bearer wrong-token')).status).toBe(401);
    expect((await lookup(regions.useast.billfn, query, TOKEN)).status).toBe(401);
    const owner = await lookup(regions.useast.billfn, query, `Bearer ${TOKEN}`);
    expect(owner.status).toBe(200);
    expect(owner.body.data).toEqual({ owned: true });
    const other = await lookup(regions.euwest.billfn, query, `Bearer ${TOKEN}`);
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual({ owned: false });
  });

  it('answers 401 when the region has no internal token configured', async () => {
    const billfn = createBillFn({ db: memoryAdapter({ debug: false }), catalog, region: { id: 'useast' } });

    expect((await lookup(billfn, 'provider=dodo&ref=sub_1', `Bearer ${TOKEN}`)).status).toBe(401);
  });

  it('rejects an unknown provider or a missing reference', async () => {
    const { regions } = createHarness();

    expect((await lookup(regions.useast.billfn, 'provider=paypal&ref=sub_1', `Bearer ${TOKEN}`)).status).toBe(400);
    expect((await lookup(regions.useast.billfn, 'provider=dodo', `Bearer ${TOKEN}`)).status).toBe(400);
  });
});
