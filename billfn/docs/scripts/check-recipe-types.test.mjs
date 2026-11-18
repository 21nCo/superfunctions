import assert from "node:assert/strict";
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

test("the ingress Worker forwards a Dodo event to the region its metadata names, unchanged", async () => {
  const { default: ingress } = await importBlock("src/ingress-worker.ts");
  const forwarded = [];
  const fakeFetch = async (input, init) => {
    const request = new Request(input, init);
    forwarded.push({ url: request.url, signature: request.headers.get("webhook-signature"), body: await request.text() });
    return new Response("accepted", { status: 200 });
  };
  const env = { BILLFN_INTERNAL_TOKEN: ["test", "internal", "token"].join("-") };
  const body = JSON.stringify({ type: "subscription.active", data: { subscription_id: "sub_test_1", metadata: { billfn_region: "euwest" } } });
  await withGlobals({ fetch: fakeFetch, console: { ...console, log: () => {} } }, async () => {
    const response = await ingress.fetch(
      new Request("https://billing-webhooks.example.com/webhooks/dodo", { method: "POST", body, headers: { "webhook-signature": "test-signature" } }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal((await ingress.fetch(new Request("https://billing-webhooks.example.com/webhooks/dodo"), env)).status, 404);
    assert.equal((await ingress.fetch(new Request("https://billing-webhooks.example.com/webhooks/stripe", { method: "POST", body }), env)).status, 404);
  });
  assert.deepEqual(forwarded, [{ url: "https://euwest.account.example.com/billfn/webhooks/dodo", signature: "test-signature", body }]);
});
