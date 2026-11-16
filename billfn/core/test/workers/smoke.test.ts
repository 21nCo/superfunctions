/**
 * Workers smoke test: worker.ts is bundled exactly as `wrangler deploy` would
 * bundle it and served by workerd (Miniflare). Every request goes through the
 * Hono host app into the BillFn router. The Dodo webhook is signed here with
 * WebCrypto, independently of the node:crypto verifier the provider uses.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DODO_WEBHOOK_SECRET,
  SMOKE_EU_SUBSCRIPTION_ID,
  SMOKE_INTERNAL_TOKEN,
  SMOKE_PRINCIPAL_ID,
  SMOKE_SUBSCRIPTION_ID
} from './fixtures.js';

const ORIGIN = 'https://billfn.smoke.test';
const COMPATIBILITY_DATE = '2025-11-13';
const COMPATIBILITY_FLAGS = ['nodejs_compat'];

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const require = createRequire(import.meta.url);

type EnvelopeBody = { ok: boolean; data?: any; error?: { code: string; status: number } };

let workDir: string;
let mf: Miniflare;

/**
 * The provider-dodo source is bundled from its sibling directory, which has no
 * node_modules of its own in an isolated core install (the tagged-release
 * flow). Its external imports therefore resolve from core, which declares
 * each of them as a devDependency.
 */
function providerDodoDependencyAliases(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(fromHere('../../../provider-dodo/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.fromEntries(
    Object.keys(manifest.dependencies ?? {})
      .filter((name) => !name.startsWith('@billfn/'))
      .map((name) => [name, require.resolve(name)])
  );
}

/** Bundles worker.ts with wrangler's deploy bundler, BillFn packages resolved to their sources. */
async function bundleWorker(outDir: string): Promise<string> {
  const config = join(workDir, 'wrangler.json');
  await writeFile(
    config,
    JSON.stringify({
      name: 'billfn-workers-smoke',
      main: fromHere('./worker.ts'),
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: COMPATIBILITY_FLAGS,
      alias: {
        ...providerDodoDependencyAliases(),
        '@billfn/core': fromHere('../../src/index.ts'),
        '@billfn/provider-dodo': fromHere('../../../provider-dodo/src/index.ts')
      }
    })
  );
  const wrangler = join(require.resolve('wrangler/package.json'), '..', 'bin', 'wrangler.js');
  await promisify(execFile)(
    process.execPath,
    [wrangler, 'deploy', '--dry-run', '--config', config, '--outdir', outDir],
    {
      cwd: workDir,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' }
    }
  );
  return readFile(join(outDir, 'worker.js'), 'utf8');
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'billfn-workers-smoke-'));
  const script = await bundleWorker(join(workDir, 'out'));
  mf = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.js', contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: COMPATIBILITY_FLAGS,
    bindings: { DODO_WEBHOOK_SECRET, INTERNAL_TOKEN: SMOKE_INTERNAL_TOKEN }
  });
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
  }
});

async function call(path: string, init?: RequestInit) {
  const response = await mf.dispatchFetch(`${ORIGIN}${path}`, init as never);
  const body = (await response.json()) as EnvelopeBody;
  return { status: response.status, body };
}

async function signDodoWebhook(id: string, timestamp: string, body: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(secret.slice('whsec_'.length)), (char) => char.charCodeAt(0)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

async function postDodoWebhook(id: string, body: string, signature?: string, path = '/billfn/webhooks/dodo') {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return call(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature ?? (await signDodoWebhook(id, timestamp, body, DODO_WEBHOOK_SECRET))
    },
    body
  });
}

const subscriptionActiveEvent = JSON.stringify({
  type: 'subscription.active',
  timestamp: '2026-11-13T00:00:00.000Z',
  data: {
    subscription_id: SMOKE_SUBSCRIPTION_ID,
    product_id: 'pdt_pro_month',
    status: 'active',
    current_period_start: '2026-11-13T00:00:00.000Z',
    next_billing_date: '2026-12-13T00:00:00.000Z'
  }
});

describe('BillFn on workerd', () => {
  it('leaves non-BillFn host routes to the Hono app', async () => {
    const response = await mf.dispatchFetch(`${ORIGIN}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('host app');
  });

  it('serves status', async () => {
    const { status, body } = await call('/billfn/status');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ ok: true, version: 1, providers: ['dodo'] });
    expect(body.data.capabilities).toContain('webhook.ingest');
  });

  it('serves the catalog', async () => {
    const { status, body } = await call('/billfn/catalog');
    expect(status).toBe(200);
    expect(body.data.plans).toHaveLength(1);
    expect(body.data.plans[0]).toMatchObject({ productKey: 'nucleus', planKey: 'pro' });
    expect(body.data.plans[0].prices[0]).toMatchObject({ provider: 'dodo', providerProductId: 'pdt_pro_month' });
  });

  it('rejects a Dodo webhook whose signature does not cover its timestamp', async () => {
    const { status, body } = await postDodoWebhook(
      'msg_smoke_forged',
      subscriptionActiveEvent,
      await signDodoWebhook('msg_smoke_forged', '0', subscriptionActiveEvent, DODO_WEBHOOK_SECRET)
    );
    expect(status).toBe(401);
    expect(body.error?.code).toBe('BILLFN_WEBHOOK_SIGNATURE_INVALID');
  });

  it('grants entitlements from a signed Dodo webhook and dedupes its redelivery', async () => {
    const subject = `principalId=${SMOKE_PRINCIPAL_ID}`;

    const before = await call(`/billfn/entitlements?${subject}`);
    expect(before.status).toBe(200);
    expect(before.body.data.entitlements ?? null).toBeNull();

    const checkout = await call('/billfn/checkouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: { principalId: SMOKE_PRINCIPAL_ID },
        planKey: 'pro',
        provider: 'dodo',
        interval: 'month'
      })
    });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.checkoutSession.providerSubscriptionId).toBe(SMOKE_SUBSCRIPTION_ID);

    const delivered = await postDodoWebhook('msg_smoke_1', subscriptionActiveEvent);
    expect(delivered.status).toBe(200);
    expect(delivered.body.data).toEqual({ accepted: true, processed: 1 });

    const after = await call(`/billfn/entitlements?${subject}`);
    expect(after.status).toBe(200);
    expect(after.body.data.subscription).toMatchObject({
      providerSubscriptionId: SMOKE_SUBSCRIPTION_ID,
      status: 'active'
    });
    expect(after.body.data.entitlements).toMatchObject({
      status: 'active',
      planKey: 'pro',
      features: { sync: true },
      limits: { storage: 1000 }
    });

    const redelivered = await postDodoWebhook('msg_smoke_1', subscriptionActiveEvent);
    expect(redelivered.status).toBe(200);
    expect(redelivered.body.data).toEqual({ accepted: true, processed: 0 });
  });
});

describe('BillFn webhook ingress on workerd', () => {
  const INGRESS_PATH = '/ingress/webhooks/dodo';
  const EU_PRINCIPAL_ID = 'smoke_eu_user';
  const euEvent = (metadata?: Record<string, string>) =>
    JSON.stringify({
      type: 'subscription.active',
      timestamp: '2026-11-13T00:00:00.000Z',
      data: {
        subscription_id: SMOKE_EU_SUBSCRIPTION_ID,
        product_id: 'pdt_pro_month',
        status: 'active',
        current_period_start: '2026-11-13T00:00:00.000Z',
        next_billing_date: '2026-12-13T00:00:00.000Z',
        ...(metadata ? { metadata } : {})
      }
    });

  const decisions = async () =>
    (await (await mf.dispatchFetch(`${ORIGIN}/fixture/ingress-decisions`)).json()) as Array<Record<string, unknown>>;

  beforeAll(async () => {
    const checkout = await call('/euwest/billfn/checkouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: { principalId: EU_PRINCIPAL_ID }, planKey: 'pro', provider: 'dodo', interval: 'month' })
    });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.checkoutSession.providerSubscriptionId).toBe(SMOKE_EU_SUBSCRIPTION_ID);
  });

  it('writes the region into the Dodo checkout metadata', async () => {
    const response = await mf.dispatchFetch(`${ORIGIN}/fixture/dodo-metadata`);
    const metadata = (await response.json()) as Array<Record<string, string>>;
    expect(metadata).toContainEqual(expect.objectContaining({ billfn_region: 'euwest' }));
  });

  it('answers an owner lookup only with the internal token', async () => {
    const path = `/euwest/billfn/ops/owner?provider=dodo&ref=${SMOKE_EU_SUBSCRIPTION_ID}`;
    expect((await call(path)).status).toBe(401);
    const owned = await call(path, { headers: { authorization: `Bearer ${SMOKE_INTERNAL_TOKEN}` } });
    expect(owned.status).toBe(200);
    expect(owned.body.data).toEqual({ owned: true });
    const elsewhere = await call(`/billfn/ops/owner?provider=dodo&ref=${SMOKE_EU_SUBSCRIPTION_ID}`, {
      headers: { authorization: `Bearer ${SMOKE_INTERNAL_TOKEN}` }
    });
    expect(elsewhere.body.data).toEqual({ owned: false });
  });

  it('forwards a forged event, which the owning region rejects', async () => {
    const body = euEvent({ billfn_region: 'euwest' });
    const forged = await signDodoWebhook('msg_ingress_forged', '0', body, DODO_WEBHOOK_SECRET);
    const { status, body: response } = await postDodoWebhook('msg_ingress_forged', body, forged, INGRESS_PATH);
    expect(status).toBe(401);
    expect(response.error?.code).toBe('BILLFN_WEBHOOK_SIGNATURE_INVALID');
    const entitlements = await call(`/euwest/billfn/entitlements?principalId=${EU_PRINCIPAL_ID}`);
    expect(entitlements.body.data.entitlements ?? null).toBeNull();
  });

  it('routes a signed Dodo event by its billfn_region metadata to the owning region', async () => {
    const delivered = await postDodoWebhook('msg_ingress_1', euEvent({ billfn_region: 'euwest' }), undefined, INGRESS_PATH);
    expect(delivered.status).toBe(200);
    expect(delivered.body.data).toEqual({ accepted: true, processed: 1 });
    expect((await decisions()).at(-1)).toMatchObject({ region: 'euwest', route: 'metadata' });

    const eu = await call(`/euwest/billfn/entitlements?principalId=${EU_PRINCIPAL_ID}`);
    expect(eu.body.data.entitlements).toMatchObject({ status: 'active', planKey: 'pro' });
    const us = await call(`/billfn/entitlements?principalId=${EU_PRINCIPAL_ID}`);
    expect(us.body.data.entitlements ?? null).toBeNull();
  });

  it('routes a Dodo event without region metadata by owner lookup', async () => {
    const delivered = await postDodoWebhook('msg_ingress_2', euEvent(), undefined, INGRESS_PATH);
    expect(delivered.status).toBe(200);
    expect(delivered.body.data).toEqual({ accepted: true, processed: 1 });
    expect((await decisions()).at(-1)).toEqual({
      provider: 'dodo',
      region: 'euwest',
      route: 'owner-lookup',
      unreachableRegions: []
    });
    const us = await call(`/billfn/entitlements?principalId=${EU_PRINCIPAL_ID}`);
    expect(us.body.data.entitlements ?? null).toBeNull();
  });
});
