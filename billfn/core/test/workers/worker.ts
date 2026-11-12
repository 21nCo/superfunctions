/**
 * Fixture Worker for the BillFn workerd smoke test: a Hono host app that mounts
 * the BillFn router at /billfn, backed by the in-memory db adapter and the real
 * Dodo provider. Outbound Dodo API calls are answered by a local fixture; no
 * network or Cloudflare account is used. State lives for the isolate's
 * lifetime, which the smoke test relies on across requests.
 */
import { Hono } from 'hono';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn, type BillFnCatalog, type BillFnInstance } from '@billfn/core';
import { createDodoProvider } from '@billfn/provider-dodo';
import { SMOKE_SUBSCRIPTION_ID } from './fixtures.js';

export interface SmokeEnv {
  DODO_WEBHOOK_SECRET: string;
}

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
        }
      ]
    }
  ]
};

/** Answers the Dodo create-subscription call the checkout route makes. */
const dodoApiFixture: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (init?.method === 'POST' && url === 'https://dodo.fixture.test/subscriptions') {
    return Response.json({
      subscription_id: SMOKE_SUBSCRIPTION_ID,
      payment_id: 'pay_smoke',
      payment_link: 'https://dodo.fixture.test/checkout/sub_smoke'
    });
  }
  return new Response('unexpected Dodo fixture request', { status: 500 });
};

let billfn: BillFnInstance | undefined;
let app: Hono<{ Bindings: SmokeEnv }> | undefined;

function getApp(env: SmokeEnv) {
  if (!app) {
    billfn = createBillFn({
      db: memoryAdapter({ debug: false }),
      catalog,
      providers: {
        dodo: createDodoProvider({
          apiKey: 'dodo_test_key',
          baseUrl: 'https://dodo.fixture.test',
          fetch: dodoApiFixture,
          webhookSecret: env.DODO_WEBHOOK_SECRET
        })
      }
    });
    const router = billfn.router;
    app = new Hono<{ Bindings: SmokeEnv }>();
    app.get('/', (c) => c.text('host app'));
    app.all('/billfn/*', (c) => router.handle(c.req.raw));
  }
  return app;
}

export default {
  fetch(request: Request, env: SmokeEnv) {
    return getApp(env).fetch(request, env);
  }
};
