import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createBillFn } from "@billfn/core";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { RECIPES, checkRecipe, extractBlocks } from "./check-recipe-types.mjs";

const ts = createRequire(import.meta.url)("typescript");

const repoRoot = resolve(import.meta.dirname, "../../..");
const [recipe] = RECIPES;
const markdown = readFileSync(resolve(repoRoot, recipe.file), "utf8");
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Imports a recipe block as a module, with the page's blocks it imports. `fakes`
 * maps a specifier (a package, or a relative path such as `./mail`) to module
 * source that replaces it; other packages resolve from the docs package.
 */
async function importBlock(path, fakes = {}) {
  const blocks = extractBlocks(markdown);
  assert.ok(blocks.some((b) => b.path === path), `no ${path} block`);
  const dir = mkdtempSync(join(tmpdir(), "billfn-recipe-"));
  const moduleFile = (blockPath) => join(dir, blockPath.replace(/\.ts$/, ".mjs"));
  const fakeUrls = {};
  for (const [index, [name, source]] of Object.entries(fakes).entries()) {
    writeFileSync(join(dir, `fake-${index}.mjs`), source);
    fakeUrls[name] = pathToFileURL(join(dir, `fake-${index}.mjs`)).href;
  }
  const resolveSpecifier = (specifier) => {
    if (fakeUrls[specifier]) return fakeUrls[specifier];
    if (specifier.startsWith(".")) return `${specifier}.mjs`;
    try {
      return import.meta.resolve(specifier);
    } catch {
      return specifier; // Only blocks that are imported must resolve.
    }
  };
  try {
    for (const block of blocks) {
      const { outputText } = ts.transpileModule(block.code, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      mkdirSync(dirname(moduleFile(block.path)), { recursive: true });
      writeFileSync(moduleFile(block.path), outputText.replace(/(from\s+)"([^"]+)"/g, (_, from, specifier) => `${from}"${resolveSpecifier(specifier)}"`));
    }
    return await import(pathToFileURL(moduleFile(path)).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `run` with the given globals defined, then restores the previous ones. */
async function withGlobals(globals, run) {
  const previous = Object.fromEntries(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

test("every TypeScript block of the multi-region Workers recipe typechecks", () => {
  const { blocks, diagnostics } = checkRecipe(recipe);
  assert.deepEqual(diagnostics, []);
  const paths = blocks.map((b) => b.path);
  for (const path of ["src/env.ts", "src/catalog.ts", "src/trial.ts", "src/plan-emails.ts", "src/billing.ts", "src/worker.ts", "src/ingress-worker.ts", "src/apple-support.ts", "src/legacy-import.ts"]) {
    assert.ok(paths.includes(path), `no ${path} block`);
  }
  assert.deepEqual(blocks.filter((b) => b.browser).map((b) => b.path), ["src/web-billing.ts"]);
});

test("a call the BillFn packages do not have, or a wrong Worker handler, is a type error", () => {
  const wrongVerifier = markdown.replace("verifier.verifyTransaction(jws)", "verifier.verify(jws)");
  assert.notEqual(wrongVerifier, markdown);
  const verifierDiagnostics = checkRecipe(recipe, wrongVerifier).diagnostics;
  assert.ok(verifierDiagnostics.some((d) => d.includes("TS2339") && d.includes("'verify'")), verifierDiagnostics.join("\n"));

  const grantWithoutPlan = markdown.replace('      planKey: "nucleus",\n      kind: "trial",', '      kind: "trial",');
  assert.notEqual(grantWithoutPlan, markdown);
  assert.ok(checkRecipe(recipe, grantWithoutPlan).diagnostics.some((d) => d.includes("planKey")));

  const wrongHandler = markdown.replace("async scheduled(controller, env) {", "async scheduled(controller: string, env) {");
  assert.notEqual(wrongHandler, markdown);
  assert.ok(checkRecipe(recipe, wrongHandler).diagnostics.length > 0);

  const wrongBridgeCall = markdown.replace("billing.checkout({", "billing.purchase({");
  assert.notEqual(wrongBridgeCall, markdown);
  assert.ok(checkRecipe(recipe, wrongBridgeCall).diagnostics.some((d) => d.includes("'purchase'")));
});

test("grantSignupTrial grants one 14-day Nucleus trial, and a rerun finds it granted", async () => {
  const { grantSignupTrial } = await importBlock("src/trial.ts");
  const { catalog } = await importBlock("src/catalog.ts");
  const { billingAccountResolver } = await importBlock("src/accounts.ts");
  const billfn = createBillFn({ db: memoryAdapter({ debug: false }), catalog, billingAccountResolver });
  const signedUpAt = new Date();

  await grantSignupTrial(billfn, "user-1", signedUpAt);
  await grantSignupTrial(billfn, "user-1", new Date(signedUpAt.getTime() + 60_000));

  const { data } = await billfn.getEntitlements({ principalId: "user-1" });
  assert.equal(data.billingAccount.id, "ba_user_user-1");
  assert.equal(data.entitlements?.status, "trialing");
  assert.deepEqual(data.entitlements?.features, { memotron: true, pointron: true });
  assert.equal(data.grants.length, 1);
  assert.equal(data.grants[0].kind, "trial");
  assert.equal(data.grants[0].planKey, "nucleus");
  assert.equal(data.grants[0].expiresAt, new Date(signedUpAt.getTime() + 14 * DAY_MS).toISOString());
});

test("every StoreKit plan mapping names the catalog Apple price of its product, so a restore without a checkout finds its price", async () => {
  const { catalog } = await importBlock("src/catalog.ts");
  const swiftPage = readFileSync(resolve(repoRoot, "billfn/docs/content/docs/clients/swift.mdx"), "utf8");
  const mappings = [...`${markdown}\n${swiftPage}`.matchAll(/^```swift\r?\n([\s\S]*?)^```/gm)].flatMap(([, code]) =>
    [...code.matchAll(/BillFnStoreKitPlan\(([^)]*)\)/g)].map(([, args]) => Object.fromEntries([...args.matchAll(/(\w+): "([^"]*)"/g)].map(([, k, v]) => [k, v])))
  );
  assert.equal(mappings.length, 3);
  for (const mapping of mappings) {
    const plan = catalog.plans.find((p) => p.planKey === mapping.planKey);
    assert.ok(plan, `no catalog plan ${mapping.planKey}`);
    const applePrices = plan.prices.filter((p) => p.provider === "apple");
    const price = applePrices.find((p) => p.providerProductId === mapping.productId);
    assert.ok(price, `no Apple price for ${mapping.productId}`);
    if (applePrices.length > 1) assert.equal(mapping.priceId, price.priceId, `${mapping.productId} needs priceId ${price.priceId}`);
    else if (mapping.priceId) assert.equal(mapping.priceId, price.priceId);
  }
});

test("grantSignupTrial rethrows every failure but an already granted trial", async () => {
  const { grantSignupTrial } = await importBlock("src/trial.ts");
  const failingWith = (error) => ({ services: { grants: { create: async () => { throw error; } } } });
  await grantSignupTrial(failingWith({ code: "BILLFN_CONFLICT", details: { reason: "trial_already_granted" } }), "user-1");
  const otherConflict = { code: "BILLFN_CONFLICT", details: { reason: "active_comp_exists" } };
  await assert.rejects(grantSignupTrial(failingWith(otherConflict), "user-1"), otherConflict);
  await assert.rejects(grantSignupTrial(failingWith(new Error("database down")), "user-1"), /database down/);
});

test("plan emails go out for checkout, renewal, cancellation and trials, keyed by the event id", async () => {
  const { planEmails } = await importBlock("src/plan-emails.ts", {
    "./mail": "export const sendPlanEmail = async (env, input) => { globalThis.sentEmails.push(input); };",
  });
  const sent = [];
  await withGlobals({ sentEmails: sent }, async () => {
    const handler = planEmails({});
    const event = (id, type, data) => handler({ id, type, billingAccountId: "ba_user_user-1", occurredAt: "2026-11-18T00:00:00.000Z", attempt: 1, data });
    await event("evt-1", "checkout.completed", { planKey: "nucleus" });
    await event("evt-2", "grant.started", { kind: "trial", planKey: "nucleus", expiresAt: "2026-12-02T00:00:00.000Z" });
    await event("evt-3", "grant.started", { kind: "comp", planKey: "nucleus", expiresAt: "2026-12-02T00:00:00.000Z" });
    await event("evt-4", "grant.expiring", { kind: "trial", planKey: "nucleus", expiresAt: "2026-12-02T00:00:00.000Z" });
    await event("evt-5", "subscription.canceled", { planKey: "nucleus", autoRenew: false, currentPeriodEnd: "2026-12-18T00:00:00.000Z" });
    await event("evt-6", "entitlement.changed", { planKey: "nucleus" });
  });
  assert.deepEqual(sent.map(({ template, idempotencyKey }) => [template, idempotencyKey]), [
    ["plan-started", "evt-1"],
    ["trial-started", "evt-2"],
    ["trial-ending", "evt-4"],
    ["plan-canceled", "evt-5"],
  ]);
  assert.deepEqual(sent[3].data, { planKey: "nucleus", endsAt: "2026-12-18T00:00:00.000Z" });
});

test("the cron schedules lifecycle-events only on the five-minute trigger and drains the queue past a failed run", async () => {
  const fakes = {
    "./billing": [
      "export const createRegion = () => ({",
      "  billfn: { enqueueReconciliationJob: async (input) => { globalThis.cron.enqueued.push(input.kind); } },",
      "  config: {},",
      "});",
    ].join("\n"),
    "@billfn/core": [
      "export const createBillFnReconciliationWorker = () => ({",
      "  async runNext() {",
      "    const next = globalThis.cron.results.shift();",
      "    globalThis.cron.runs += 1;",
      "    if (next instanceof Error) throw next;",
      "    return next ?? null;",
      "  },",
      "});",
    ].join("\n"),
  };
  const { default: worker } = await importBlock("src/worker.ts", fakes);
  const cron = { enqueued: [], results: [], runs: 0 };
  await withGlobals({ cron, console: { ...console, error: () => {} } }, async () => {
    cron.results = [{ id: "job-1" }, new Error("dead-lettered"), { id: "job-2" }, null, { id: "never-claimed" }];
    await worker.scheduled({ cron: "*/5 * * * *" }, {});
    assert.deepEqual(cron.enqueued, ["lifecycle-events"]);
    assert.equal(cron.runs, 4); // stops at the empty queue

    cron.results = [null];
    await worker.scheduled({ cron: "* * * * *" }, {});
    assert.deepEqual(cron.enqueued, ["lifecycle-events"]);
  });
});

test("the cron stops draining after three failures in a row, such as an unreachable queue database", async () => {
  const fakes = {
    "./billing": "export const createRegion = () => ({ billfn: {}, config: {} });",
    "@billfn/core": [
      "export const createBillFnReconciliationWorker = () => ({",
      "  async runNext() {",
      "    globalThis.cron.runs += 1;",
      "    const next = globalThis.cron.results.shift();",
      "    if (next === undefined) throw new Error('connect ECONNREFUSED');",
      "    if (next instanceof Error) throw next;",
      "    return next;",
      "  },",
      "});",
    ].join("\n"),
  };
  const { default: worker } = await importBlock("src/worker.ts", fakes);
  const cron = { results: [], runs: 0 };
  await withGlobals({ cron, console: { ...console, error: () => {} } }, async () => {
    // Failures separated by a success do not stop the run.
    cron.results = [new Error("job failed"), new Error("job failed"), { id: "job-1" }, new Error("job failed"), new Error("job failed"), null];
    await worker.scheduled({ cron: "* * * * *" }, {});
    assert.equal(cron.runs, 6);

    // A queue that keeps failing (nothing left in results) ends the run after three calls, not at the 50s budget.
    cron.runs = 0;
    cron.results = [];
    const started = Date.now();
    await worker.scheduled({ cron: "* * * * *" }, {});
    assert.equal(cron.runs, 3);
    assert.ok(Date.now() - started < 1_000);
  });
});

test("the regional Worker serves /auth and /billfn and nothing else", async () => {
  const { default: worker } = await importBlock("src/worker.ts", {
    "./billing": [
      "const answer = (name) => ({ router: { handle: async (request) => new Response(name + ' ' + new URL(request.url).pathname) } });",
      "export const createRegion = () => ({ auth: answer('auth'), billfn: answer('billfn') });",
    ].join("\n"),
  });
  const get = async (path) => {
    const response = await worker.fetch(new Request(`https://euwest.account.example.com${path}`), {});
    return [response.status, await response.text()];
  };
  assert.deepEqual(await get("/auth/session"), [200, "auth /auth/session"]);
  assert.deepEqual(await get("/billfn/webhooks/dodo"), [200, "billfn /billfn/webhooks/dodo"]);
  assert.deepEqual(await get("/billfn"), [200, "billfn /billfn"]);
  assert.equal((await get("/billfnx"))[0], 404);
  assert.equal((await get("/"))[0], 404);
});

/** A fake service binding that records each request and answers with `answer(request)`. */
function fakeBinding(name, calls, answer) {
  return {
    async fetch(input, init) {
      const request = new Request(input, init);
      calls.push({ binding: name, method: request.method, url: request.url, authorization: request.headers.get("authorization"), signature: request.headers.get("webhook-signature"), body: request.method === "POST" ? await request.text() : null });
      return answer(request);
    },
  };
}

test("the ingress Worker looks up owners and forwards through the regions' service bindings, never the global fetch", async () => {
  const { default: ingress } = await importBlock("src/ingress-worker.ts");
  const calls = [];
  const internalToken = ["test", "internal", "token"].join("-");
  const owned = (owner) => (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/billfn/ops/owner") return Response.json({ data: { owned: owner } });
    return new Response("accepted", { status: 200 });
  };
  const env = {
    BILLFN_INTERNAL_TOKEN: internalToken,
    INSOUTH: fakeBinding("INSOUTH", calls, owned(true)),
    USEAST: fakeBinding("USEAST", calls, owned(false)),
    EUWEST: fakeBinding("EUWEST", calls, owned(false)),
  };
  const deliver = (provider, body, init = {}) =>
    ingress.fetch(new Request(`https://billing-webhooks.example.com/webhooks/${provider}`, { method: "POST", body, headers: { "webhook-signature": "test-signature" }, ...init }), env);
  const globalFetch = async () => { throw new Error("the global fetch skips Workers routed in the same zone"); };

  await withGlobals({ fetch: globalFetch, console: { ...console, log: () => {} } }, async () => {
    // Region metadata: straight to that region's binding, unchanged.
    const tagged = JSON.stringify({ type: "subscription.active", data: { subscription_id: "sub_test_1", metadata: { billfn_region: "euwest" } } });
    assert.equal((await deliver("dodo", tagged)).status, 200);
    assert.deepEqual(calls.splice(0), [
      { binding: "EUWEST", method: "POST", url: "https://euwest.account.example.com/billfn/webhooks/dodo", authorization: null, signature: "test-signature", body: tagged },
    ]);

    // No metadata: every region's binding is asked, and the owner gets the event.
    const untagged = JSON.stringify({ type: "subscription.renewed", data: { subscription_id: "sub_test_2" } });
    assert.equal((await deliver("dodo", untagged)).status, 200);
    const lookups = calls.filter((call) => call.method === "GET");
    assert.deepEqual(lookups.map((call) => call.binding).sort(), ["EUWEST", "INSOUTH", "USEAST"]);
    for (const lookup of lookups) {
      assert.match(lookup.url, /^https:\/\/\w+\.account\.example\.com\/billfn\/ops\/owner\?provider=dodo&ref=sub_test_2$/);
      assert.equal(lookup.authorization, `Bearer ${internalToken}`);
    }
    assert.deepEqual(calls.filter((call) => call.method === "POST"), [
      { binding: "INSOUTH", method: "POST", url: "https://insouth.account.example.com/billfn/webhooks/dodo", authorization: null, signature: "test-signature", body: untagged },
    ]);
    calls.splice(0);

    assert.equal((await ingress.fetch(new Request("https://billing-webhooks.example.com/webhooks/dodo"), env)).status, 404);
    assert.equal((await deliver("stripe", tagged)).status, 404);
    assert.deepEqual(calls, []);
  });
});

test("billing's resolveSubject makes BillFn answer 401 without an AuthFn session and 403 on a CSRF mismatch", async () => {
  const memoryUrl = import.meta.resolve("@superfunctions/db/adapters/memory");
  const { createRegion } = await importBlock("src/billing.ts", {
    authfn: [
      "export class AuthFnError extends Error { constructor(message, status) { super(message); this.status = status; } }",
      "export class AuthFnCsrfInvalidError extends AuthFnError { constructor() { super('CSRF token mismatch', 403); } }",
      // The x-test-session header picks what the fake AuthFn does with the request.
      "const session = (request) => {",
      "  const value = request.headers.get('x-test-session');",
      "  if (value === 'expired') throw new AuthFnError('Session expired', 401);",
      "  if (value === 'csrf' && request.method !== 'GET') throw new AuthFnCsrfInvalidError();",
      "  return value && value !== 'csrf' ? { actorId: value } : null;",
      "};",
      "export const authfn = () => ({ createServer: () => ({",
      "  provider: { authenticate: async (request) => session(request) },",
      "  authorizeMutation: async (request) => session(request),",
      "}) });",
    ].join("\n"),
    "@authfn/password": "export const authFnPasswordPlugin = () => ({});",
    // The memory adapter has no rawSql; these routes queue nothing.
    "@superfunctions/queue": "export class DatabaseQueueAdapter {}",
    "./database": `import { memoryAdapter } from "${memoryUrl}"; export const createDatabase = () => memoryAdapter({ debug: false });`,
    "./discount-tiers": "export const discountTierOf = async () => null;",
    "./mail": "export const sendPlanEmail = async () => {};",
  });
  const env = {
    BILLFN_REGION: "euwest",
    BILLFN_INTERNAL_TOKEN: "test-internal-token",
    BILLFN_OPS_TOKEN: "test-ops-token",
    DODO_API_KEY: "test-dodo-api-key",
    DODO_WEBHOOK_SECRET: "test-dodo-webhook-secret",
    DODO_ENVIRONMENT: "test_mode",
    APPLE_ENVIRONMENT: "sandbox",
    APPLE_ISSUER_ID: "test-issuer-id",
    APPLE_KEY_ID: "test-key-id",
    // The adapter parses its key up front; a throwaway one is made per run.
    APPLE_IN_APP_PURCHASE_KEY: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const { billfn } = createRegion(env);
  const call = async (method, path, session, body) => {
    const headers = { "content-type": "application/json", ...(session ? { "x-test-session": session } : {}) };
    const response = await billfn.router.handle(new Request(`https://euwest.account.example.com/billfn${path}`, { method, headers, body: body && JSON.stringify(body) }));
    const json = await response.json();
    return [response.status, json.error?.code ?? null];
  };
  const checkout = { planKey: "nucleus", provider: "dodo", interval: "month", subject: { principalId: "someone-else" } };

  assert.deepEqual(await call("GET", "/entitlements"), [401, "BILLFN_UNAUTHENTICATED"]);
  assert.deepEqual(await call("GET", "/entitlements", "expired"), [401, "BILLFN_UNAUTHENTICATED"]);
  assert.deepEqual(await call("POST", "/checkouts", undefined, checkout), [401, "BILLFN_UNAUTHENTICATED"]);
  assert.deepEqual(await call("POST", "/checkouts", "csrf", checkout), [403, "BILLFN_UNAUTHORIZED"]);
  assert.deepEqual(await call("GET", "/entitlements", "user-1"), [200, null]);
  assert.equal((await billfn.router.handle(new Request("https://euwest.account.example.com/billfn/catalog"))).status, 200);
});

/** A fake WKWebView host: answers each bridge message with `answer(message)` and records the methods it received. */
function fakeNativeHost(answer) {
  const received = [];
  const window = {
    webkit: {
      messageHandlers: {
        billfn: {
          postMessage(message) {
            received.push(message.method);
            const reply = answer(message);
            queueMicrotask(() => window.__billfnBridgeReceive__({ protocol: message.protocol, id: message.id, ...reply }));
          },
        },
      },
    },
  };
  return { window, received };
}

test("buyNucleusYearly handshakes with the native host before the StoreKit checkout, and retries a failed handshake", async () => {
  const handshake = { ok: true, result: { bridgeVersion: 1, billingOwner: "native", capabilities: ["storekit.checkout"] } };
  const cancelled = { ok: true, result: { status: "cancelled", checkoutSessionId: "cs_test_1", productId: "com.example.nucleus.year" } };

  const host = fakeNativeHost((message) => (message.method === "handshake" ? handshake : cancelled));
  await withGlobals({ window: host.window }, async () => {
    const { buyNucleusYearly } = await importBlock("src/web-billing.ts");
    assert.equal(await buyNucleusYearly(), "cancelled");
    assert.equal(await buyNucleusYearly(), "cancelled");
  });
  assert.deepEqual(host.received, ["handshake", "storekit.checkout", "storekit.checkout"]);

  let handshakes = 0;
  const flaky = fakeNativeHost((message) => {
    if (message.method !== "handshake") return cancelled;
    handshakes += 1;
    return handshakes === 1 ? { ok: false, error: { code: "BRIDGE_UNAVAILABLE", message: "native host not ready" } } : handshake;
  });
  await withGlobals({ window: flaky.window }, async () => {
    const { buyNucleusYearly } = await importBlock("src/web-billing.ts");
    await assert.rejects(buyNucleusYearly(), { code: "BRIDGE_UNAVAILABLE" });
    assert.equal(await buyNucleusYearly(), "cancelled");
  });
  assert.deepEqual(flaky.received, ["handshake", "handshake", "storekit.checkout"]);
});

test("a pending checkout's later transaction.updated outcome reaches onTransactionUpdated until stopBilling", async () => {
  const handshake = { ok: true, result: { bridgeVersion: 1, billingOwner: "native", capabilities: ["storekit.checkout"] } };
  const pending = { ok: true, result: { status: "pending", checkoutSessionId: "cs_test_1", productId: "com.example.nucleus.year" } };
  const transaction = { transactionId: "2000000000000002", originalTransactionId: "2000000000000001", productId: "com.example.nucleus.year", appAccountToken: null, revoked: false };
  const outcome = { transaction, status: "confirmed", finished: true, billing: {} };
  const host = fakeNativeHost((message) => (message.method === "handshake" ? handshake : pending));
  // The native app posts dispatcher.transactionEvent(outcome) once the Ask to Buy purchase is approved.
  const approve = () => host.window.__billfnBridgeReceive__({ protocol: "billfn-bridge/v1", event: "transaction.updated", payload: { outcome } });

  await withGlobals({ window: host.window }, async () => {
    const { buyNucleusYearly, onTransactionUpdated, stopBilling } = await importBlock("src/web-billing.ts");
    const seen = [];
    onTransactionUpdated((update) => seen.push(update));
    try {
      assert.equal(await buyNucleusYearly(), "pending");
      approve();
      assert.deepEqual(seen, [outcome]);
    } finally {
      stopBilling();
    }
    approve();
    assert.deepEqual(seen, [outcome], "no outcome after stopBilling");
  });
  assert.deepEqual(host.received, ["handshake", "storekit.checkout"]);
});

test("onTransactionUpdated receives transaction.updated outcomes without a checkout, and again after stopBilling", async () => {
  const transaction = { transactionId: "2000000000000004", originalTransactionId: "2000000000000003", productId: "com.example.nucleus.month", appAccountToken: null, revoked: false };
  const renewal = { transaction, status: "confirmed", finished: true, billing: {} };
  const host = fakeNativeHost(() => {
    throw new Error("no bridge request expected");
  });
  // A renewal, or an Ask to Buy approval after the page was reloaded: no checkout runs in this page.
  // With no subscription the page may have no receiver at all; the event is then dropped, as in the app.
  const post = () => host.window.__billfnBridgeReceive__?.({ protocol: "billfn-bridge/v1", event: "transaction.updated", payload: { outcome: renewal } });

  await withGlobals({ window: host.window }, async () => {
    const { onTransactionUpdated, stopBilling } = await importBlock("src/web-billing.ts");
    const first = [];
    const removeFirst = onTransactionUpdated((update) => first.push(update));
    post();
    assert.deepEqual(first, [renewal], "a listener registered without a checkout receives the outcome");

    stopBilling();
    const second = [];
    const removeSecond = onTransactionUpdated((update) => second.push(update));
    post();
    assert.deepEqual(second, [renewal], "a listener registered after stopBilling receives the outcome");
    assert.deepEqual(first, [renewal], "stopBilling removed the earlier listener");

    removeFirst();
    removeSecond();
    post();
    assert.deepEqual(second, [renewal], "removing the last listener unsubscribes");

    const third = [];
    onTransactionUpdated((update) => third.push(update));
    post();
    assert.deepEqual(third, [renewal], "a later registration subscribes again");
    stopBilling();
  });
  assert.deepEqual(host.received, []);
});

test("a transaction.updated listener that throws does not keep the outcome from the other listeners", async () => {
  const transaction = { transactionId: "2000000000000006", originalTransactionId: "2000000000000005", productId: "com.example.nucleus.month", appAccountToken: null, revoked: false };
  const renewal = { transaction, status: "confirmed", finished: true, billing: {} };
  const host = fakeNativeHost(() => {
    throw new Error("no bridge request expected");
  });
  const post = () => host.window.__billfnBridgeReceive__({ protocol: "billfn-bridge/v1", event: "transaction.updated", payload: { outcome: renewal } });
  const reported = [];

  await withGlobals({ window: host.window, console: { ...console, error: (...args) => reported.push(args) } }, async () => {
    const { onTransactionUpdated, stopBilling } = await importBlock("src/web-billing.ts");
    const seen = [];
    onTransactionUpdated(() => {
      throw new Error("entitlement refresh failed");
    });
    onTransactionUpdated((update) => seen.push(update));
    try {
      post();
      assert.deepEqual(seen, [renewal], "the second listener receives the outcome after the first throws");
      assert.equal(reported.length, 1, "the throwing listener is reported");
      assert.equal(reported[0][1].message, "entitlement refresh failed");
    } finally {
      stopBilling();
    }
  });
  assert.deepEqual(host.received, []);
});
