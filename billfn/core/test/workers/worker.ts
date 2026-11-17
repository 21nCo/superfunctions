/**
 * Fixture Worker for the BillFn workerd smoke test: a Hono host app that mounts
 * the BillFn router at /billfn (region useast) and a second BillFn at
 * /euwest/billfn (region euwest), each backed by its own in-memory db adapter
 * and the real Dodo provider, plus the public webhook ingress at
 * /ingress/webhooks/:provider that routes each event to its owning region.
 * Outbound Dodo API calls are answered by a local fixture, and the ingress
 * reaches the regions through this app; no network or Cloudflare account is
 * used. State lives for the isolate's lifetime, which the smoke test relies on
 * across requests.
 */
import { Hono } from 'hono';
import { memoryAdapter } from '@superfunctions/db/testing';
import {
  createBillFn,
  createWebhookIngress,
  type BillFnCatalog,
  type BillFnIngressRouteDecision,
  type BillFnWebhookIngress,
  type BillingProviderName
} from '@billfn/core';
import { createDodoProvider } from '@billfn/provider-dodo';
import { SMOKE_EU_SUBSCRIPTION_ID, SMOKE_SUBSCRIPTION_ID } from './fixtures.js';

export interface SmokeEnv {
  DODO_WEBHOOK_SECRET: string;
  INTERNAL_TOKEN: string;
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

/** The metadata of every Dodo create-subscription call, served at /fixture/dodo-metadata. */
const dodoCheckoutMetadata: unknown[] = [];

/** Answers the Dodo create-subscription call the checkout route makes, with one subscription per region. */
function dodoApiFixture(subscriptionId: string): typeof fetch {
  return async (input, init) => {
    let url: string;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = input.url;
    }
    if (init?.method === 'POST' && url === 'https://dodo.fixture.test/checkouts') {
      dodoCheckoutMetadata.push((JSON.parse(String(init.body)) as { metadata?: unknown }).metadata);
      // A Dodo checkout session; the subscription it starts reaches BillFn in a webhook with the session's metadata.
      return Response.json({
        session_id: `cks_${subscriptionId}`,
        checkout_url: `https://dodo.fixture.test/checkout/cks_${subscriptionId}`
      });
    }
    return new Response('unexpected Dodo fixture request', { status: 500 });
  };
}

/** Every ingress routing decision, served at /fixture/ingress-decisions. */
const ingressDecisions: BillFnIngressRouteDecision[] = [];

let app: Hono<{ Bindings: SmokeEnv }> | undefined;
let ingress: BillFnWebhookIngress | undefined;

function createRegion(env: SmokeEnv, id: string, basePath: string, subscriptionId: string) {
  return createBillFn({
    db: memoryAdapter({ debug: false }),
    catalog,
    basePath,
    region: { id, internalToken: env.INTERNAL_TOKEN },
    providers: {
      dodo: createDodoProvider({
        apiKey: 'dodo_test_key',
        baseUrl: 'https://dodo.fixture.test',
        fetch: dodoApiFixture(subscriptionId),
        webhookSecret: env.DODO_WEBHOOK_SECRET
      })
    }
  });
}

function getApp(env: SmokeEnv) {
  if (!app) {
    const useast = createRegion(env, 'useast', '/billfn', SMOKE_SUBSCRIPTION_ID).router;
    const euwest = createRegion(env, 'euwest', '/euwest/billfn', SMOKE_EU_SUBSCRIPTION_ID).router;
    const host = new Hono<{ Bindings: SmokeEnv }>();
    host.get('/', (c) => c.text('host app'));
    host.get('/fixture/dodo-metadata', (c) => c.json(dodoCheckoutMetadata));
    host.get('/fixture/ingress-decisions', (c) => c.json(ingressDecisions));
    host.all('/billfn/*', (c) => useast.handle(c.req.raw));
    host.all('/euwest/billfn/*', (c) => euwest.handle(c.req.raw));
    host.all('/ingress/webhooks/:provider', (c) => {
      if (!ingress) {
        const origin = new URL(c.req.url).origin;
        ingress = createWebhookIngress({
          regions: [
            { id: 'useast', url: `${origin}/billfn` },
            { id: 'euwest', url: `${origin}/euwest/billfn` }
          ],
          defaultRegion: 'useast',
          internalToken: env.INTERNAL_TOKEN,
          onRoute: (decision) => ingressDecisions.push(decision),
          // The regions are served by this Worker, so the ingress reaches them in-process.
          fetch: async (input, init) => host.fetch(new Request(input, init), env)
        });
      }
      return ingress.handle(c.req.param('provider') as BillingProviderName, c.req.raw);
    });
    app = host;
  }
  return app;
}

export default {
  fetch(request: Request, env: SmokeEnv) {
    return getApp(env).fetch(request, env);
  }
};
