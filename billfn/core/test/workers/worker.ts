/**
 * Fixture Worker for the BillFn workerd smoke test: a Hono host app that mounts
 * the BillFn router at /billfn (region useast) and a second BillFn at
 * /euwest/billfn (region euwest), each backed by its own in-memory db adapter
 * and the real Dodo provider, plus the public webhook ingress at
 * /ingress/webhooks/:provider that routes each event to its owning region.
 * Outbound Dodo API calls are answered by a local fixture, and the ingress
 * reaches the regions through this app; no network or Cloudflare account is
 * used. The useast region also runs the Apple provider with its built-in
 * notification verifier and App Store Server API token signer. State lives for the isolate's lifetime, which the smoke test relies on
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
import { createAppleProvider } from '@billfn/provider-apple';
import { createDodoProvider } from '@billfn/provider-dodo';
// Not exported from the package: verification against a given root, for Apple's published test chains.
import {
  createAppleSignedDataVerifierForRoot,
  verifyAppleCertificateChainToPinnedRoot
} from '../../../provider-apple/src/signed-data-verifier.js';
import {
  APPLE_REAL_CHAIN_EFFECTIVE_DATE,
  APPLE_REAL_INTERMEDIATE,
  APPLE_REAL_ROOT,
  APPLE_REAL_SIGNING_CERTIFICATE
} from '../../../provider-apple/src/__tests__/fixtures/apple-published-samples.js';
import { SMOKE_APPLE_BUNDLE_ID, SMOKE_EU_SUBSCRIPTION_ID, SMOKE_SUBSCRIPTION_ID } from './fixtures.js';

export interface SmokeEnv {
  DODO_WEBHOOK_SECRET: string;
  INTERNAL_TOKEN: string;
  /** A PKCS#8 PEM P-256 key the test generates, standing in for an App Store Connect in-app purchase key. */
  APPLE_API_PRIVATE_KEY: string;
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

/** The authorization header of every App Store Server API call, served at /fixture/apple-authorizations. */
const appleAuthorizations: string[] = [];

/** Answers every App Store Server API call as StoreKit does for an unknown transaction, recording its token. */
const appleApiFixture: typeof fetch = async (_input, init) => {
  appleAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
  return Response.json({ errorCode: 4040010, errorMessage: 'Transaction id not found.' }, { status: 404 });
};

function createApple(env: SmokeEnv) {
  return createAppleProvider({
    bundleId: SMOKE_APPLE_BUNDLE_ID,
    appStoreServerApiKey: { issuerId: 'smoke-issuer', keyId: 'SMOKEKEY01', privateKey: env.APPLE_API_PRIVATE_KEY },
    fetch: appleApiFixture
  });
}

/**
 * Runs the Apple signed data verifier on workerd: the production App Store chain against the pinned root, and a JWS
 * against the root the test names (Apple's published sample root or a generated one).
 */
async function verifyAppleFixture(request: Request) {
  const { jws, root, bundleId, kind } = (await request.json()) as { jws: string; root: string; bundleId: string; kind?: string };
  const run = async (action: () => Promise<unknown>) => {
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      return { ok: false, reason: (error as { reason?: string }).reason ?? String(error) };
    }
  };
  const verifier = createAppleSignedDataVerifierForRoot({ bundleId, rootCertificate: root });
  return {
    pinnedRealChain: await run(async () => {
      await verifyAppleCertificateChainToPinnedRoot(
        [APPLE_REAL_SIGNING_CERTIFICATE, APPLE_REAL_INTERMEDIATE, APPLE_REAL_ROOT],
        APPLE_REAL_CHAIN_EFFECTIVE_DATE
      );
      return 'verified';
    }),
    jws: await run(() => (kind === 'transaction' ? verifier.verifyTransaction(jws) : verifier.verifyNotification(jws)))
  };
}

/** Every ingress routing decision, served at /fixture/ingress-decisions. */
const ingressDecisions: BillFnIngressRouteDecision[] = [];

let app: Hono<{ Bindings: SmokeEnv }> | undefined;
let ingress: BillFnWebhookIngress | undefined;

function createRegion(env: SmokeEnv, id: string, basePath: string, subscriptionId: string, withApple = false) {
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
      }),
      ...(withApple ? { apple: createApple(env) } : {})
    }
  });
}

function getApp(env: SmokeEnv) {
  if (!app) {
    const useast = createRegion(env, 'useast', '/billfn', SMOKE_SUBSCRIPTION_ID, true).router;
    const euwest = createRegion(env, 'euwest', '/euwest/billfn', SMOKE_EU_SUBSCRIPTION_ID).router;
    const host = new Hono<{ Bindings: SmokeEnv }>();
    host.get('/', (c) => c.text('host app'));
    host.get('/fixture/dodo-metadata', (c) => c.json(dodoCheckoutMetadata));
    host.get('/fixture/ingress-decisions', (c) => c.json(ingressDecisions));
    host.get('/fixture/apple-authorizations', (c) => c.json(appleAuthorizations));
    host.post('/fixture/apple-verify', async (c) => c.json(await verifyAppleFixture(c.req.raw)));
    host.post('/fixture/apple-import', async (c) => {
      // The import reads StoreKit with a token from the built-in signer; the fixture answers not found.
      const imported = await createApple(c.env).importSubscription!({ providerReference: 'smoke_original_txn' } as never);
      return c.json({ imported });
    });
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
