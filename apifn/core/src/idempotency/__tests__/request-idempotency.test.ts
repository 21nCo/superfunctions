import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  createRequestIdempotency,
  normalizeIdempotentResponse,
  sha256Fingerprint,
  type IdempotencyCommit,
  type IdempotencyDiagnostic,
  type IdempotencyReceipt,
  type IdempotencyReceiptSource,
  type IdempotencyRecord,
  type IdempotencyRequest,
  type IdempotencyStore,
  type IdempotencyToken,
  type IdempotentResponse,
  type RequestIdempotencyOptions,
} from "../../index.js";

/** Yields to other pending callers so concurrent operations interleave. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Atomic conditional store: each operation is atomic, but callers interleave between operations. */
class FakeAtomicStore implements IdempotencyStore {
  readonly records = new Map<string, IdempotencyRecord>();
  writes = 0;

  async get(storeKey: string): Promise<IdempotencyRecord | undefined> {
    await tick();
    const record = this.records.get(storeKey);
    return record ? structuredClone(record) : undefined;
  }

  async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean> {
    await tick();
    const current = this.records.get(storeKey);
    if ((current?.version ?? null) !== expectedVersion) return false;
    this.writes += 1;
    if (next === null) this.records.delete(storeKey);
    else this.records.set(storeKey, structuredClone(next));
    return true;
  }
}

/**
 * Application database whose order handler writes its effect and its receipt in one
 * transaction. Receipts are unique per store key, like a primary key, so a second commit
 * for the same key fails the whole transaction.
 */
class FakeOrderDatabase {
  readonly orders: string[] = [];
  readonly receiptsByKey = new Map<string, IdempotencyReceipt>();

  readonly receipts = {
    find: async (storeKey: string): Promise<IdempotencyReceipt | undefined> => {
      await tick();
      return this.receiptsByKey.get(storeKey);
    },
  };

  async createOrder(commit: IdempotencyCommit, item: string): Promise<IdempotentResponse> {
    await tick();
    if (this.receiptsByKey.has(commit.storeKey)) throw new Error("receipt already committed for this key");
    const response = { status: 201, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: this.orders.length + 1, item }) };
    this.orders.push(item);
    this.receiptsByKey.set(commit.storeKey, { ...commit, response });
    return response;
  }
}

/** Atomic store that runs a hook just before the first compare-and-set against a chosen version. */
class HookedStore extends FakeAtomicStore {
  constructor(private readonly hook: { version?: string; run?: () => Promise<void> } = {}) {
    super();
  }

  arm(version: string, run: () => Promise<void>) {
    this.hook.version = version;
    this.hook.run = run;
  }

  override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean> {
    const { run } = this.hook;
    if (run && expectedVersion === this.hook.version) {
      this.hook.run = undefined;
      await run();
    }
    return super.compareAndSet(storeKey, expectedVersion, next);
  }
}

class FakeClock {
  constructor(public time = 1_000_000) {}
  now = () => this.time;
  advance(ms: number) {
    this.time += ms;
  }
}

let nonceCounter = 0;
const testNonce = () => `test-version-${(nonceCounter += 1)}`;

function setup(overrides: Partial<RequestIdempotencyOptions> = {}) {
  const store = new FakeAtomicStore();
  const database = new FakeOrderDatabase();
  const clock = new FakeClock();
  const options: RequestIdempotencyOptions = {
    store,
    receipts: database.receipts,
    clock,
    leaseMs: 1_000,
    retentionMs: 60_000,
    nonce: testNonce,
    ...overrides,
  };
  return { store, database, clock, idempotency: createRequestIdempotency(options) };
}

const orderRequest = (overrides: Partial<IdempotencyRequest> = {}): IdempotencyRequest => ({
  scope: { principal: "user-1", tenant: "tenant-a", operation: "createOrder", target: "store-1" },
  key: "order-key-1",
  body: { item: "book", quantity: 1 },
  recovery: "receipt",
  ...overrides,
});

function acquired(result: Awaited<ReturnType<ReturnType<typeof createRequestIdempotency>["claim"]>>): IdempotencyToken {
  if (result.outcome !== "acquired") throw new Error(`expected acquired, got ${result.outcome}`);
  return result.token;
}

describe("createRequestIdempotency", () => {
  it("lets exactly one of several racing callers run the handler, then replays its response", async () => {
    const { idempotency, database } = setup();

    const run = async () => {
      const claim = await idempotency.claim(orderRequest());
      if (claim.outcome !== "acquired") return claim;
      const response = await database.createOrder(claim.token, "book");
      await idempotency.settle(claim.token, response);
      return { outcome: "ran" as const };
    };
    const results = await Promise.all([run(), run(), run(), run(), run()]);

    expect(results.filter((result) => result.outcome === "ran")).toHaveLength(1);
    // Losers see the claim in progress, or replay once the winner's receipt is committed.
    for (const result of results.filter((entry) => entry.outcome !== "ran")) {
      expect(["in_progress", "replay"]).toContain(result.outcome);
    }
    expect(database.orders).toEqual(["book"]);

    // The receipt is the commit evidence; the store never records a copy of it.
    const retry = await idempotency.claim(orderRequest());
    expect(retry).toMatchObject({ outcome: "replay", source: "receipt", response: { status: 201 } });
    expect(retry.outcome === "replay" && JSON.parse(retry.response.body!)).toEqual({ id: 1, item: "book" });
  });

  it("grants a racing claim to exactly one caller and reports the rest in progress", async () => {
    const { idempotency } = setup();
    const results = await Promise.all(Array.from({ length: 6 }, () => idempotency.claim(orderRequest())));
    expect(results.filter((result) => result.outcome === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "in_progress")).toHaveLength(5);
  });

  it("reports a conflict for a different body under the same key, while pending and after completion", async () => {
    const { idempotency } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));

    expect(await idempotency.claim(orderRequest({ body: { item: "pen", quantity: 1 } }))).toEqual({ outcome: "conflict" });
    await idempotency.settle(token, { status: 200, body: "done" });
    expect(await idempotency.claim(orderRequest({ body: { item: "book", quantity: 2 } }))).toEqual({ outcome: "conflict" });
    // Key order is not part of the body's identity.
    expect(await idempotency.claim(orderRequest({ body: { quantity: 1, item: "book" } }))).toMatchObject({ outcome: "replay" });
  });

  it("keeps a stale holder from settling or clearing a newer claim", async () => {
    const { idempotency, clock, database, store } = setup();
    const stale = acquired(await idempotency.claim(orderRequest()));

    clock.advance(1_001); // the first holder's lease expires without a receipt
    const current = acquired(await idempotency.claim(orderRequest()));
    expect(current.generation).toBe(stale.generation + 1);

    expect(await idempotency.settle(stale, { status: 200, body: "stale" })).toEqual({ outcome: "stale" });
    expect(await idempotency.release(stale)).toEqual({ outcome: "stale" });
    expect([...store.records.values()][0]).toMatchObject({ state: "pending", generation: current.generation });

    const response = await database.createOrder(current, "book");
    expect(await idempotency.settle(current, response)).toMatchObject({ outcome: "settled" });
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", response: { status: 201 } });
  });

  it("replays the receipt when a process restarts after commit and before responding", async () => {
    const shared = setup();
    const token = acquired(await shared.idempotency.claim(orderRequest()));
    await shared.database.createOrder(token, "book");
    // The process dies here: no settle, and the client never saw the response.

    const restarted = createRequestIdempotency({
      store: shared.store,
      receipts: shared.database.receipts,
      clock: shared.clock,
      leaseMs: 1_000,
      retentionMs: 60_000,
      nonce: testNonce,
    });
    // The lease is still live, but the receipt proves the commit.
    const retry = await restarted.claim(orderRequest());
    expect(retry).toMatchObject({ outcome: "replay", source: "receipt", response: { status: 201 } });
    expect(await restarted.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    expect(shared.database.orders).toEqual(["book"]);

    // The original holder learns its own commit was recorded; its late result never overwrites the receipt.
    expect(await shared.idempotency.settle(token, { status: 500 })).toMatchObject({ outcome: "settled", response: { status: 201 } });
    expect(await restarted.claim(orderRequest())).toMatchObject({ outcome: "replay", response: { status: 201 } });
  });

  it("recovers a dropped response through recover() without running the handler again", async () => {
    const { idempotency, database, clock } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    expect(await idempotency.recover(orderRequest())).toMatchObject({ outcome: "in_progress" });
    clock.advance(1_001);
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "not_committed" });

    await database.createOrder(token, "book");
    expect(await idempotency.recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    expect(await idempotency.recover(orderRequest({ key: "order-key-2" }))).toEqual({ outcome: "absent" });
  });

  it("records the commit instead of freeing the key when a holder releases after committing", async () => {
    const { idempotency, database, clock } = setup();
    const slow = acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);
    const current = acquired(await idempotency.claim(orderRequest()));

    // The slow holder commits after the takeover; the new holder's commit then fails.
    await database.createOrder(slow, "book");
    await expect(database.createOrder(current, "book")).rejects.toThrow("receipt already committed");
    expect(await idempotency.release(current)).toMatchObject({ outcome: "committed", response: { status: 201 } });
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay" });
    expect(database.orders).toEqual(["book"]);
  });

  it("frees the key when a holder releases before committing", async () => {
    const { idempotency } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    expect(await idempotency.release(token)).toEqual({ outcome: "released" });
    const next = acquired(await idempotency.claim(orderRequest()));
    expect(next.version).not.toBe(token.version);
    expect(await idempotency.settle(token, { status: 200 })).toEqual({ outcome: "stale" });
  });

  it("replays from the receipt when the claim record was lost", async () => {
    const { idempotency, database, store } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    await database.createOrder(token, "book");
    store.records.clear();

    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    expect(await idempotency.claim(orderRequest({ body: { item: "pen" } }))).toEqual({ outcome: "conflict" });
    expect(database.orders).toEqual(["book"]);
  });

  it.each([
    ["principal", { principal: "user-2" }],
    ["tenant", { tenant: "tenant-b" }],
    ["operation", { operation: "cancelOrder" }],
    ["target", { target: "store-2" }],
  ])("never replays another scope when the %s changes", async (_field, change) => {
    const { idempotency, database } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    await idempotency.settle(token, await database.createOrder(token, "book"));

    const other = orderRequest({ scope: { ...orderRequest().scope, ...change } });
    expect(await idempotency.recover(other)).toEqual({ outcome: "absent" });
    const otherToken = acquired(await idempotency.claim(other));
    expect(otherToken.storeKey).not.toBe(token.storeKey);
  });

  it("keeps scope fields from running together", async () => {
    const { idempotency } = setup();
    const first = acquired(
      await idempotency.claim(orderRequest({ scope: { principal: "a", tenant: "b:c", operation: "op" } })),
    );
    const second = await idempotency.claim(orderRequest({ scope: { principal: "a:b", tenant: "c", operation: "op" } }));
    expect(acquired(second).storeKey).not.toBe(first.storeKey);
  });

  it("does not re-run an expired claim when the handler has no receipt contract", async () => {
    const { idempotency, clock } = setup({ receipts: undefined });
    const request = orderRequest({ recovery: "none" });
    const first = acquired(await idempotency.claim(request));

    clock.advance(1_001);
    expect(await idempotency.claim(request)).toEqual({ outcome: "indeterminate", retryAfterMs: 58_999 });
    expect(await idempotency.recover(request)).toMatchObject({ outcome: "indeterminate" });

    clock.advance(59_000); // retention ends
    const second = acquired(await idempotency.claim(request));
    expect(second.generation).toBe(first.generation + 1);
  });

  it("refuses commit recovery for handlers without a durable receipt source", async () => {
    const { idempotency } = setup({ receipts: undefined });
    await expect(idempotency.claim(orderRequest({ recovery: "receipt" }))).rejects.toThrow(
      /needs a receipts source with durable commit evidence/,
    );
  });

  it("ignores receipts for claims that did not opt into receipt recovery", async () => {
    const { idempotency, clock } = setup();
    const request = orderRequest({ recovery: "none" });
    acquired(await idempotency.claim(request));
    clock.advance(1_001);
    expect(await idempotency.claim(request)).toMatchObject({ outcome: "indeterminate" });
  });

  it("bounds only the stored replay copy, drops credential headers from it and returns the full response", async () => {
    const { idempotency, store } = setup({ maxResponseBytes: 256 });
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    const response = {
      status: 201,
      headers: { "Content-Type": "application/json", "Set-Cookie": "session=test-session", authorization: "Bearer test-token" },
      body: "x".repeat(1_000),
    };

    // The first caller gets its own full response, not the bounded copy.
    expect(await idempotency.settle(token, response)).toEqual({ outcome: "settled", response });
    expect([...store.records.values()][0]).toMatchObject({
      response: { status: 201, headers: { "content-type": "application/json" }, omitted: ["body"] },
    });
    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toEqual({
      outcome: "replay",
      source: "store",
      response: { status: 201, headers: { "content-type": "application/json" }, omitted: ["body"] },
    });
    const stored = JSON.stringify([...store.records.values()]);
    expect(stored).not.toContain("test-session");
    expect(stored).not.toContain("test-token");
    expect(stored.length).toBeLessThan(1_000);
  });

  it("emits diagnostics without principal, tenant, target, key, body or header values", async () => {
    const events: IdempotencyDiagnostic[] = [];
    const { idempotency } = setup({
      onDiagnostic: (event) => {
        events.push(event);
        throw new Error("a failing listener does not change outcomes");
      },
    });
    const request = orderRequest({
      scope: { principal: "principal-test-password", tenant: "tenant-secret", operation: "createOrder", target: "target-secret" },
      key: "key-test-token",
      body: { password: "body-test-password" },
    });
    const token = acquired(await idempotency.claim(request));
    await idempotency.claim(request);
    await idempotency.settle(token, { status: 200, headers: { authorization: "Bearer header-test-token" }, body: "ok" });
    await idempotency.recover(request);
    await idempotency.claim({ ...request, key: "" });

    expect(events.map((event) => `${event.action}:${event.outcome}`)).toEqual([
      "claim:acquired",
      "claim:in_progress",
      "settle:settled",
      "recover:replay",
      "claim:invalid_key",
    ]);
    const serialized = JSON.stringify(events);
    for (const value of ["principal-test-password", "tenant-secret", "target-secret", "key-test-token", "body-test-password", "header-test-token"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("rejects invalid keys before touching the store", async () => {
    const { idempotency, store } = setup();
    expect(await idempotency.claim(orderRequest({ key: "" }))).toEqual({ outcome: "invalid_key", reason: "empty" });
    expect(await idempotency.claim(orderRequest({ key: "k".repeat(256) }))).toEqual({ outcome: "invalid_key", reason: "too_long" });
    expect(await idempotency.claim(orderRequest({ key: "has space" }))).toEqual({ outcome: "invalid_key", reason: "characters" });
    expect(store.writes).toBe(0);
  });

  it("requires a principal and an operation in the scope", async () => {
    const { idempotency } = setup();
    await expect(idempotency.claim(orderRequest({ scope: { principal: "", operation: "createOrder" } }))).rejects.toThrow(/principal/);
    await expect(idempotency.claim(orderRequest({ scope: { principal: "user-1", operation: "" } }))).rejects.toThrow(/operation/);
  });

  it("fails closed on malformed store records and receipts without echoing them", async () => {
    const { idempotency, store, database } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    store.records.set(token.storeKey, { state: "pending", version: "v", fingerprint: "secret-fingerprint" } as unknown as IdempotencyRecord);
    await expect(idempotency.claim(orderRequest())).rejects.toThrow(/^idempotency store returned a malformed record$/);

    store.records.clear();
    database.receiptsByKey.set(token.storeKey, { ...token, storeKey: "another-scope", response: { status: 200 } });
    await expect(idempotency.claim(orderRequest())).rejects.toThrow(/receipt for a different key/);
  });

  it("validates its options", () => {
    const store = new FakeAtomicStore();
    expect(() => createRequestIdempotency({ store, leaseMs: Number.POSITIVE_INFINITY, nonce: testNonce })).toThrow(/leaseMs/);
    expect(() => createRequestIdempotency({ store, leaseMs: 10, retentionMs: 5, nonce: testNonce })).toThrow(/retentionMs/);
    expect(() => createRequestIdempotency({ store, maxResponseBytes: 0, nonce: testNonce })).toThrow(/maxResponseBytes/);
    expect(() => createRequestIdempotency({ store: {} as IdempotencyStore })).toThrow(/compareAndSet/);
  });

  it("uses portable SHA-256 and Web Crypto versions by default", async () => {
    // Node 18 has no global Web Crypto by default; the fixture supplies the standard one.
    if (!(globalThis as { crypto?: unknown }).crypto) vi.stubGlobal("crypto", webcrypto);
    const store = new FakeAtomicStore();
    const idempotency = createRequestIdempotency({ store });
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    vi.unstubAllGlobals();
    expect(token.storeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(token.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Fingerprint("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});

describe("createRequestIdempotency receipt reconciliation", () => {
  it("settles a takeover with the late holder's committed receipt instead of the takeover's error", async () => {
    const { idempotency, database, clock } = setup();
    const slow = acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);
    const current = acquired(await idempotency.claim(orderRequest()));

    // The slow holder commits after the takeover; the takeover's commit then fails and it settles its error.
    await database.createOrder(slow, "book");
    await expect(database.createOrder(current, "book")).rejects.toThrow("receipt already committed");
    const settled = await idempotency.settle(current, { status: 409, body: "duplicate" });

    expect(settled).toMatchObject({ outcome: "committed", response: { status: 201 } });
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", response: { status: 201 } });
    expect(await idempotency.recover(orderRequest())).toMatchObject({ outcome: "replay", response: { status: 201 } });
    // The slow holder's own commit is the recorded result, so it settles rather than failing as stale.
    expect(await idempotency.settle(slow, { status: 500 })).toMatchObject({ outcome: "settled", response: { status: 201 } });
    expect(database.orders).toEqual(["book"]);
  });

  it.each([
    ["claim", "settle"],
    ["claim", "release"],
    ["recover", "settle"],
    ["recover", "release"],
  ] as const)(
    "reports the holder's own commit when a concurrent %s recorded its receipt before %s",
    async (reader, finish) => {
      const { idempotency, database, store } = setup();
      const holder = acquired(await idempotency.claim(orderRequest()));
      const committed = await database.createOrder(holder, "book");
      // A retry records the holder's receipt first, so the holder's version no longer matches.
      expect(await idempotency[reader](orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
      const recorded = [...store.records.values()][0];

      const result = finish === "settle" ? await idempotency.settle(holder, committed) : await idempotency.release(holder);
      expect(result).toEqual({ outcome: finish === "settle" ? "settled" : "committed", response: committed });
      // The reader wrote nothing; settle records the result it reported over the holder's own version.
      if (finish === "release") expect([...store.records.values()][0]).toEqual(recorded);
      else expect([...store.records.values()][0]).toMatchObject({ state: "completed", generation: holder.generation, response: committed });
      expect(database.orders).toEqual(["book"]);
    },
  );

  it("records a holder's commit over a newer takeover claim and settles the holder", async () => {
    const { idempotency, database, clock } = setup();
    const slow = acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);
    const current = acquired(await idempotency.claim(orderRequest()));
    // The slow holder commits after the takeover; its commit evidence wins over the newer pending claim.
    const committed = await database.createOrder(slow, "book");

    expect(await idempotency.settle(slow, committed)).toEqual({ outcome: "settled", response: committed });
    await expect(database.createOrder(current, "book")).rejects.toThrow("receipt already committed");
    expect(await idempotency.release(current)).toEqual({ outcome: "committed", response: committed });
    expect(database.orders).toEqual(["book"]);
  });

  it.each(["settle", "release"] as const)(
    "refuses to %s a receipt token on an instance without a receipts source, before any store write",
    async (finish) => {
      const { idempotency, store, clock } = setup();
      const token = acquired(await idempotency.claim(orderRequest()));
      const withoutReceipts = createRequestIdempotency({ store, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
      const before = structuredClone([...store.records.values()]);
      const writes = store.writes;

      const finishing =
        finish === "settle" ? withoutReceipts.settle(token, { status: 500 }) : withoutReceipts.release(token);
      await expect(finishing).rejects.toThrow(TypeError);
      await expect(finishing).rejects.toThrow(/receipts source/);
      expect(store.writes).toBe(writes);
      expect([...store.records.values()]).toEqual(before);
    },
  );

  it("returns a committed receipt's full response and replays it in full from the receipt", async () => {
    const { idempotency, store } = setup({ maxResponseBytes: 256 });
    const holder = acquired(await idempotency.claim(orderRequest()));
    const response = { status: 201, headers: { "content-type": "application/json", "content-length": "1002" }, body: JSON.stringify("x".repeat(1_000)) };
    const receipts = new Map<string, IdempotencyReceipt>([[holder.storeKey, { ...holder, response }]]);
    const large = createRequestIdempotency({
      store,
      receipts: { find: async (storeKey) => receipts.get(storeKey) },
      clock: new FakeClock(),
      leaseMs: 1_000,
      retentionMs: 60_000,
      maxResponseBytes: 256,
      nonce: testNonce,
    });

    expect(await large.settle(holder, { status: 500 })).toEqual({ outcome: "settled", response });
    // The settled record is bounded, but a replay reads the full response from the receipt while it is readable.
    expect([...store.records.values()][0]).toMatchObject({ state: "completed", response: { omitted: ["body"] } });
    expect(await large.claim(orderRequest())).toEqual({ outcome: "replay", source: "receipt", response });
    expect(await large.recover(orderRequest())).toEqual({ outcome: "replay", source: "receipt", response });
  });

  it("settles a holder's own commit with its receipt's response", async () => {
    const { idempotency, database } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    await database.createOrder(token, "book");
    // The handler's in-memory response differs from what it committed: the receipt wins.
    expect(await idempotency.settle(token, { status: 500 })).toMatchObject({ outcome: "settled", response: { status: 201 } });
  });

  it("replays a receipt committed after another holder settled without one", async () => {
    const { idempotency, database, clock } = setup();
    const slow = acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);
    const current = acquired(await idempotency.claim(orderRequest()));
    // The takeover fails before committing and settles its error; the slow holder commits afterwards.
    expect(await idempotency.settle(current, { status: 503 })).toMatchObject({ outcome: "settled", response: { status: 503 } });
    await database.createOrder(slow, "book");

    // The receipt is read before the takeover's settled record, every time.
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt", response: { status: 201 } });
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt", response: { status: 201 } });
    expect(database.orders).toEqual(["book"]);
  });

  it.each(["settle", "release"] as const)(
    "reports a conflict, not the other body's response, when %s finds a receipt for a different body",
    async (finish) => {
      const { idempotency, database, clock } = setup();
      const first = acquired(await idempotency.claim(orderRequest()));
      clock.advance(60_000); // the first claim's retention ends while its handler still runs
      const other = acquired(await idempotency.claim(orderRequest({ body: { item: "pen", quantity: 1 } })));

      await database.createOrder(first, "book");
      await expect(database.createOrder(other, "pen")).rejects.toThrow("receipt already committed");
      const result = finish === "settle" ? await idempotency.settle(other, { status: 409 }) : await idempotency.release(other);

      expect(result).toEqual({ outcome: "conflict" });
      expect(await idempotency.claim(orderRequest({ body: { item: "pen", quantity: 1 } }))).toEqual({ outcome: "conflict" });
      expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", response: { status: 201 } });
      expect(database.orders).toEqual(["book"]);
    },
  );

  it("never lets a request without receipt recovery take over or read a receipt claim", async () => {
    const { idempotency, database, clock } = setup();
    const holder = acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);

    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toEqual({ outcome: "conflict" });
    expect(await idempotency.recover(orderRequest({ recovery: "none" }))).toEqual({ outcome: "conflict" });
    await database.createOrder(holder, "book");
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toEqual({ outcome: "conflict" });
  });

  it("never lets a receipt request take over a claim made without receipt recovery", async () => {
    const { idempotency, clock } = setup();
    acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    clock.advance(1_001);

    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "conflict" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "conflict" });
    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toMatchObject({ outcome: "indeterminate" });
  });

  it("distinguishes an omitted body from a JSON null body", async () => {
    const { idempotency } = setup();
    const noBody = orderRequest({ body: undefined, recovery: "none" });
    const token = acquired(await idempotency.claim(noBody));
    await idempotency.settle(token, { status: 204 });

    expect(await idempotency.claim({ ...noBody, body: null })).toEqual({ outcome: "conflict" });
    expect(await idempotency.claim(noBody)).toMatchObject({ outcome: "replay", response: { status: 204 } });
  });

  it("derives store keys with SHA-256 even when the host supplies the body digest", async () => {
    const events: IdempotencyDiagnostic[] = [];
    const { idempotency } = setup({ fingerprint: (canonical) => canonical, onDiagnostic: (event) => events.push(event) });
    const token = acquired(await idempotency.claim(orderRequest()));

    expect(token.storeKey).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(events)).not.toMatch(/user-1|tenant-a|store-1|order-key-1/);
  });

  it("never replays credential, framing or bodiless representation headers from a stored record", async () => {
    const { idempotency, store } = setup();
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    const headers = { "content-type": "text/plain", "set-cookie": "session=test-session", "transfer-encoding": "chunked", etag: '"v1"' };
    store.records.set(token.storeKey, {
      state: "completed",
      version: "v",
      generation: 1,
      fingerprint: token.fingerprint,
      recovery: "none",
      expiresAt: 2_000_000,
      response: { status: 200, headers, omitted: ["body"] },
    });

    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toEqual({
      outcome: "replay",
      source: "store",
      response: { status: 200, headers: { "content-type": "text/plain" }, omitted: ["body"] },
    });
  });

  it("rejects tokens and receipts with a non-positive generation", async () => {
    const { idempotency, database } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    await expect(idempotency.settle({ ...token, generation: 0 }, { status: 200 })).rejects.toThrow(/token from claim/);
    await expect(idempotency.release({ ...token, generation: -1 })).rejects.toThrow(/token from claim/);
    database.receiptsByKey.set(token.storeKey, { ...token, generation: 0, response: { status: 201 } });
    await expect(idempotency.claim(orderRequest())).rejects.toThrow(/malformed receipt/);
  });

  it("ignores a rejected promise from an async diagnostic listener", async () => {
    const rejected: string[] = [];
    const { idempotency } = setup({
      onDiagnostic: (event) => {
        rejected.push(event.outcome);
        return Promise.reject(new Error("listener failed")) as unknown as void;
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
      expect(await idempotency.settle(token, { status: 204 })).toMatchObject({ outcome: "settled" });
      await tick();
      await tick();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(rejected).toEqual(["acquired", "settled"]);
    expect(unhandled).toEqual([]);
  });

  it("fails closed on stored responses the write path would reject", async () => {
    const { idempotency, store } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    const base = { state: "completed", version: "v", generation: 1, fingerprint: token.fingerprint, recovery: "receipt", expiresAt: 2_000_000 };
    for (const response of [
      { status: 42, headers: {} },
      { status: 200, headers: { "x-a": "a\r\nb" } },
      { status: 200, headers: { "Bad Name": "a" } },
      { status: 200, headers: {}, body: "kept", omitted: ["body"] },
    ]) {
      store.records.set(token.storeKey, { ...base, response } as unknown as IdempotencyRecord);
      await expect(idempotency.claim(orderRequest())).rejects.toThrow(/malformed record/);
    }
  });
});

describe("canonicalJson", () => {
  it("sorts keys, omits undefined properties and matches JSON for plain data", () => {
    const value = { b: [1, "x", null], a: { d: true, c: -0 }, e: undefined, toJSON: "a data member" };
    expect(canonicalJson(value)).toBe('{"a":{"c":0,"d":true},"b":[1,"x",null],"toJSON":"a data member"}');
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
    expect(canonicalJson(Object.assign(Object.create(null), { z: 1, a: 2 }))).toBe('{"a":2,"z":1}');
  });

  it("rejects values a JSON serializer would convert, so they never alias plain data", () => {
    class Order {
      item = "book";
    }
    // eslint-disable-next-line no-sparse-arrays
    const holes = [1, , 3];
    for (const value of [
      new Date(0),
      Buffer.from("a"),
      new Order(),
      { toJSON: () => "converted" },
      Object.assign([1], { toJSON: () => [2] }),
      holes,
      new Array(1),
      [1, undefined, 3],
      undefined,
    ]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
      expect(() => canonicalJson({ nested: [value] })).toThrow(TypeError);
    }
  });

  it("refuses a body that is not plain JSON data instead of aliasing its JSON form", async () => {
    const { idempotency, store } = setup();
    await expect(idempotency.claim(orderRequest({ body: { at: new Date(0) } }))).rejects.toThrow(TypeError);
    await expect(idempotency.claim(orderRequest({ body: { data: Buffer.from("a") } }))).rejects.toThrow(TypeError);
    expect(store.writes).toBe(0);
    acquired(await idempotency.claim(orderRequest({ body: { at: "1970-01-01T00:00:00.000Z" } })));
  });

  it("rejects values that JSON would change or collapse", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1, Symbol("s"), new Map([["a", 1]]), new Set([1]), cycle]) {
      expect(() => canonicalJson({ value })).toThrow(TypeError);
    }
  });
});

describe("normalizeIdempotentResponse", () => {
  it("rejects invalid statuses, header values and bodies", () => {
    expect(() => normalizeIdempotentResponse({ status: 99 })).toThrow(/status/);
    expect(() => normalizeIdempotentResponse({ status: 200, headers: { "x-a": "a\r\nb" } })).toThrow(/single-line/);
    expect(() => normalizeIdempotentResponse({ status: 200, headers: { "bad name": "a" } })).toThrow(/header name/);
    expect(() => normalizeIdempotentResponse({ status: 200, body: {} as unknown as string })).toThrow(/body/);
  });

  it("drops the body's representation headers with the body and never stores framing headers", () => {
    const headers = {
      "content-type": "application/json",
      "content-length": "1000",
      "content-encoding": "gzip",
      etag: '"v1"',
      "content-digest": "sha-256=:test-digest:",
      "transfer-encoding": "chunked",
    };
    expect(normalizeIdempotentResponse({ status: 200, headers, body: "x".repeat(1_000) }, { maxBytes: 400 })).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      omitted: ["body"],
    });
    expect(normalizeIdempotentResponse({ status: 200, headers, body: "x" }).headers).not.toHaveProperty("transfer-encoding");
    expect(normalizeIdempotentResponse({ status: 204, headers: { "x-large": "y".repeat(100) } }, { maxBytes: 50 })).toEqual({
      status: 204,
      headers: {},
      omitted: ["headers"],
    });
  });

  it("drops headers too when they alone exceed the bound", () => {
    expect(normalizeIdempotentResponse({ status: 200, headers: { "x-large": "y".repeat(100) }, body: "z" }, { maxBytes: 50 })).toEqual({
      status: 200,
      headers: {},
      omitted: ["body", "headers"],
    });
  });
});

describe("createRequestIdempotency round-3 regressions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["expired", "evicted"] as const)(
    "keeps a retained receipt authoritative for a request without receipt recovery after the record is %s",
    async (loss) => {
      const { idempotency, database, clock, store } = setup();
      const holder = acquired(await idempotency.claim(orderRequest()));
      await idempotency.settle(holder, await database.createOrder(holder, "book"));
      clock.advance(60_001);
      if (loss === "evicted") store.records.clear();
      const writes = store.writes;

      // Neither acquires (no second effect) nor exposes the committed response.
      expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toEqual({ outcome: "conflict" });
      expect(await idempotency.recover(orderRequest({ recovery: "none" }))).toEqual({ outcome: "conflict" });
      expect(store.writes).toBe(writes);
      expect(database.orders).toEqual(["book"]);
      expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt", response: { status: 201 } });
    },
  );

  it("resolves a committed receipt before validating the holder's response", async () => {
    const { idempotency, database, clock } = setup();
    const slow = acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);
    const current = acquired(await idempotency.claim(orderRequest()));
    await database.createOrder(slow, "book");

    // An invalid response is never used when commit evidence decides the result.
    const invalid = { status: 0 } as IdempotentResponse;
    expect(await idempotency.settle(current, invalid)).toMatchObject({ outcome: "committed", response: { status: 201 } });
    expect(await idempotency.settle(slow, invalid)).toMatchObject({ outcome: "settled", response: { status: 201 } });
    // Without a receipt the response is still validated.
    const { idempotency: other } = setup();
    const token = acquired(await other.claim(orderRequest({ recovery: "none" })));
    await expect(other.settle(token, invalid)).rejects.toThrow(/status/);
  });

  it.each(["settle", "release"] as const)(
    "reports a commit that lands during the holder's final %s write instead of its fallback",
    async (action) => {
      const store = new HookedStore();
      const { idempotency, database, clock } = setup({ store });
      const slow = acquired(await idempotency.claim(orderRequest()));
      clock.advance(1_001);
      const current = acquired(await idempotency.claim(orderRequest()));
      // The receipt lookup has already found nothing when the old holder commits.
      store.arm(current.version, async () => {
        await database.createOrder(slow, "book");
      });

      const result =
        action === "settle" ? await idempotency.settle(current, { status: 503, body: "retry" }) : await idempotency.release(current);
      expect(result).toMatchObject({ outcome: "committed", response: { status: 201 } });
      expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", response: { status: 201 } });
      expect(database.orders).toEqual(["book"]);
    },
  );

  it("keeps the holder's own Set-Cookie on its own commit and strips credentials from another holder's", async () => {
    const { idempotency, database, clock } = setup();
    const own = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(own, "book");
    const sent = { ...committed, headers: { ...committed.headers, "Set-Cookie": "session=test-session-value" } };
    expect(await idempotency.settle(own, sent)).toEqual({
      outcome: "settled",
      response: { ...committed, headers: { ...committed.headers, "set-cookie": "session=test-session-value" } },
    });

    const slow = acquired(await idempotency.claim(orderRequest({ key: "order-key-2" })));
    clock.advance(1_001);
    const current = acquired(await idempotency.claim(orderRequest({ key: "order-key-2" })));
    database.receiptsByKey.set(slow.storeKey, {
      storeKey: slow.storeKey,
      fingerprint: slow.fingerprint,
      generation: slow.generation,
      claimId: slow.claimId,
      response: { status: 201, headers: { "set-cookie": "session=test-session-value", "content-type": "text/plain" }, body: "ok" },
    });
    const result = await idempotency.settle(current, { status: 409 });
    expect(result).toEqual({ outcome: "committed", response: { status: 201, headers: { "content-type": "text/plain" }, body: "ok" } });
  });

  it("derives store keys and default fingerprints without ambient Web Crypto", async () => {
    vi.stubGlobal("crypto", undefined);
    expect((globalThis as { crypto?: unknown }).crypto).toBeUndefined();
    const store = new FakeAtomicStore();
    const database = new FakeOrderDatabase();
    const idempotency = createRequestIdempotency({ store, receipts: database.receipts, nonce: testNonce });

    const token = acquired(await idempotency.claim(orderRequest()));
    expect(token.storeKey).toMatch(/^[0-9a-f]{64}$/);
    await idempotency.settle(token, await database.createOrder(token, "book"));
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", response: { status: 201 } });
    for (const input of ["", "abc", "é".repeat(100), "x".repeat(55), "x".repeat(64)]) {
      expect(await sha256Fingerprint(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
    expect(() => createRequestIdempotency({ store })).toThrow(/options\.nonce/);
  });
});

describe("createRequestIdempotency round-4 regressions", () => {
  const cookieResponse = { status: 201, headers: { "set-cookie": "session=test-session-value", "content-type": "text/plain" }, body: "ok" };

  it.each([
    ["evicted", "settle"],
    ["evicted", "release"],
    ["released", "settle"],
    ["released", "release"],
  ] as const)(
    "reports another claim's receipt as committed, without its credentials, after the first record was %s (%s)",
    async (loss, action) => {
      const { idempotency, database, store } = setup();
      const first = acquired(await idempotency.claim(orderRequest()));
      if (loss === "evicted") store.records.clear();
      else expect(await idempotency.release(first)).toEqual({ outcome: "released" });

      const second = acquired(await idempotency.claim(orderRequest()));
      // Eviction restarts the generation; a release tombstone continues it.
      expect(second.generation).toBe(loss === "evicted" ? first.generation : first.generation + 1);
      expect(second.claimId).not.toBe(first.claimId);
      // The first claim's handler commits late; the second claim's commit then fails.
      database.receiptsByKey.set(first.storeKey, { ...first, response: cookieResponse });

      const result = action === "settle" ? await idempotency.settle(second, { status: 409 }) : await idempotency.release(second);
      expect(result).toEqual({ outcome: "committed", response: { status: 201, headers: { "content-type": "text/plain" }, body: "ok" } });
    },
  );

  it("keeps a release tombstone with the generation until retention ends", async () => {
    const { idempotency, store, clock } = setup();
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    clock.advance(10);
    expect(await idempotency.release(token)).toEqual({ outcome: "released" });
    expect(store.records.get(token.storeKey)).toMatchObject({ state: "released", generation: token.generation, expiresAt: clock.time + 60_000 });
    // A released key is free for any body.
    const next = acquired(await idempotency.claim(orderRequest({ recovery: "none", body: { item: "pen" } })));
    expect(next.generation).toBe(token.generation + 1);
  });

  it("settles with the receipt's response when the holder's response differs only in a header", async () => {
    const { idempotency, database } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(token, "book");
    database.receiptsByKey.set(token.storeKey, { ...token, response: { ...committed, headers: { ...committed.headers, location: "/orders/1" } } });

    const sent = { ...committed, headers: { ...committed.headers, location: "/orders/other" } };
    const result = await idempotency.settle(token, sent);
    expect(result).toEqual({ outcome: "settled", response: { ...committed, headers: { "content-type": "application/json", location: "/orders/1" } } });
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", response: { headers: { location: "/orders/1" } } });
  });

  it("drops fields a Connection header nominates on write and on replay", async () => {
    const headers = { Connection: "close, X-Hop-Trace", "X-Hop-Trace": "test-trace", "x-keep": "kept" };
    expect(normalizeIdempotentResponse({ status: 200, headers })).toEqual({ status: 200, headers: { "x-keep": "kept" } });

    const { idempotency, store } = setup();
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    store.records.set(token.storeKey, {
      state: "completed",
      version: "v",
      generation: 1,
      fingerprint: token.fingerprint,
      recovery: "none",
      expiresAt: 2_000_000,
      response: { status: 200, headers: { connection: "x-hop-trace", "x-hop-trace": "test-trace", "x-keep": "kept" } },
    });
    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toMatchObject({
      outcome: "replay",
      response: { status: 200, headers: { "x-keep": "kept" } },
    });
  });

  it("fails closed on stored records and receipts that contradict the write path", async () => {
    const { idempotency, store, database } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    const base = { state: "completed", version: "v", generation: 1, fingerprint: token.fingerprint, recovery: "receipt", expiresAt: 2_000_000 };
    for (const record of [
      { ...base, response: { status: 200, headers: { "x-a": "a" }, omitted: ["headers"] } },
      { ...base, response: { status: 200, headers: {}, body: "kept", omitted: ["headers"] } },
      { ...base, response: { status: 200, headers: {}, omitted: [] } },
      { ...base, response: { status: 200, headers: {}, omitted: ["body", "body"] } },
      // A receipt copy an earlier build wrote (its marker field built at runtime): no completed record carries one now.
      { ...base, recovery: "none", [["from", "Receipt"].join("")]: true, response: { status: 200, headers: {} } },
    ]) {
      store.records.set(token.storeKey, record as unknown as IdempotencyRecord);
      await expect(idempotency.claim(orderRequest(record.recovery === "none" ? { recovery: "none" } : {}))).rejects.toThrow(/malformed record/);
    }

    store.records.clear();
    for (const receipt of [
      { ...token, response: { status: 0 } },
      { ...token, response: { status: 201, headers: { "x-a": "a\r\nb" } } },
      { ...token, response: { status: 201, body: 42 } },
      { ...token, claimId: "", response: { status: 201 } },
    ]) {
      database.receiptsByKey.set(token.storeKey, receipt as unknown as IdempotencyReceipt);
      await expect(idempotency.claim(orderRequest())).rejects.toThrow(/malformed receipt/);
      await expect(idempotency.settle(token, { status: 201 })).rejects.toThrow(/malformed receipt/);
    }
  });

  it("starts the lease at the claim write, after a slow receipt lookup", async () => {
    const clock = new FakeClock();
    const database = new FakeOrderDatabase();
    let slowLookups = 1;
    const receipts = {
      find: async (storeKey: string) => {
        if (slowLookups > 0) {
          slowLookups -= 1;
          clock.advance(5_000); // longer than the lease
        }
        return database.receipts.find(storeKey);
      },
    };
    const { idempotency } = setup({ clock, receipts });
    const first = acquired(await idempotency.claim(orderRequest()));
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "in_progress" });
    expect(first.generation).toBe(1);
  });
});

/** Atomic store whose first `slowWrites` claim writes take longer than the lease. */
class SlowAcquireStore extends FakeAtomicStore {
  constructor(
    private readonly clock: FakeClock,
    private slowWrites: number,
  ) {
    super();
  }

  override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean> {
    const written = await super.compareAndSet(storeKey, expectedVersion, next);
    if (next?.state === "pending" && this.slowWrites > 0) {
      this.slowWrites -= 1;
      this.clock.advance(1_500); // the lease is 1_000
    }
    return written;
  }
}

describe("createRequestIdempotency round-5 regressions", () => {
  it("settles with the receipt's response when the holder's response repeats a header name in another case", async () => {
    const { idempotency, database, store } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    const receiptResponse = { status: 201, headers: { location: "/orders/1" }, body: '{"id":1}' };
    database.receiptsByKey.set(token.storeKey, { ...token, response: receiptResponse });

    const doubled = { status: 201, headers: { Location: "/orders/1", location: "/orders/1" }, body: '{"id":1}' };
    expect(await idempotency.settle(token, doubled)).toEqual({ outcome: "settled", response: receiptResponse });
    expect(() => normalizeIdempotentResponse(doubled)).toThrow(/repeats a header name/);

    const plain = acquired(await idempotency.claim(orderRequest({ key: "order-key-2", recovery: "none" })));
    const writes = store.writes;
    await expect(idempotency.settle(plain, doubled)).rejects.toThrow(/repeats a header name/);
    expect(store.writes).toBe(writes);
  });

  it("never hands out a claim whose lease lapsed during the claim write", async () => {
    const clock = new FakeClock();
    const store = new SlowAcquireStore(clock, 1);
    const { idempotency } = setup({ clock, store });
    const token = acquired(await idempotency.claim(orderRequest()));
    // The lapsed first write was released, and the retry claimed the key with a live lease.
    expect(token.generation).toBe(2);
    const record = store.records.get(token.storeKey);
    expect(record).toMatchObject({ state: "pending", generation: 2 });
    expect(record?.state === "pending" && record.leaseExpiresAt > clock.now()).toBe(true);
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "in_progress" });

    const alwaysSlowClock = new FakeClock();
    const alwaysSlow = new SlowAcquireStore(alwaysSlowClock, Number.POSITIVE_INFINITY);
    const slow = setup({ clock: alwaysSlowClock, store: alwaysSlow });
    expect(await slow.idempotency.claim(orderRequest())).toEqual({ outcome: "in_progress", retryAfterMs: 1 });
    expect([...alwaysSlow.records.values()][0]).toMatchObject({ state: "released" });
  });

  it("fails closed on sparse omitted lists and on a lease that outlives its record", async () => {
    const { idempotency, store } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    const base = { version: "v", generation: 1, fingerprint: token.fingerprint, recovery: "receipt", expiresAt: 2_000_000 };
    for (const record of [
      { ...base, state: "completed", response: { status: 200, headers: {}, omitted: new Array(1) } },
      { ...base, state: "pending", leaseExpiresAt: 2_000_001 },
    ]) {
      store.records.set(token.storeKey, record as unknown as IdempotencyRecord);
      await expect(idempotency.recover(orderRequest())).rejects.toThrow(/malformed record/);
    }
  });

  it("replays only the response fields of a stored record", async () => {
    const { idempotency, store } = setup();
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    store.records.set(token.storeKey, {
      state: "completed",
      version: "v",
      generation: 1,
      fingerprint: token.fingerprint,
      recovery: "none",
      expiresAt: 2_000_000,
      response: { status: 200, headers: { "x-keep": "kept" }, body: "done", internal: "test-internal-field" },
    } as unknown as IdempotencyRecord);
    const replay = await idempotency.claim(orderRequest({ recovery: "none" }));
    expect(replay).toEqual({ outcome: "replay", source: "store", response: { status: 200, headers: { "x-keep": "kept" }, body: "done" } });
  });

  it("keeps a released or expired receipt claim's contract against a request without receipt recovery", async () => {
    const { idempotency, database, clock, store } = setup();
    const withoutReceipts = createRequestIdempotency({ store, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
    const none = orderRequest({ recovery: "none" });

    // Released tombstone of a receipt claim.
    const released = acquired(await idempotency.claim(orderRequest()));
    expect(await idempotency.release(released)).toEqual({ outcome: "released" });
    for (const instance of [idempotency, withoutReceipts]) {
      expect(await instance.claim(none)).toEqual({ outcome: "conflict" });
      expect(await instance.recover(none)).toEqual({ outcome: "conflict" });
    }

    // Expired but not yet evicted receipt claim, on an instance with no receipts source.
    const holder = acquired(await idempotency.claim(orderRequest({ key: "order-key-2" })));
    await idempotency.settle(holder, await database.createOrder(holder, "book"));
    clock.advance(60_001);
    const writes = store.writes;
    expect(await withoutReceipts.claim(orderRequest({ key: "order-key-2", recovery: "none" }))).toEqual({ outcome: "conflict" });
    expect(await withoutReceipts.recover(orderRequest({ key: "order-key-2", recovery: "none" }))).toEqual({ outcome: "conflict" });
    expect(store.writes).toBe(writes);
    expect(database.orders).toEqual(["book"]);
  });

  it("releases a claim without receipt recovery when a receipt lands during its claim write", async () => {
    const database = new FakeOrderDatabase();
    let landed = false;
    class LateReceiptStore extends FakeAtomicStore {
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        if (!landed && next?.state === "pending") {
          landed = true;
          const fingerprint = next.fingerprint;
          const commit = { storeKey, fingerprint, generation: 1, claimId: "test-claim-other" };
          database.receiptsByKey.set(storeKey, { ...commit, response: { status: 201, body: "{}" } });
        }
        return super.compareAndSet(storeKey, expectedVersion, next);
      }
    }
    const store = new LateReceiptStore();
    const { idempotency } = setup({ store, receipts: database.receipts });
    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toEqual({ outcome: "conflict" });
    // The tombstone keeps the receipt contract, so an instance without receipts still refuses the key.
    expect([...store.records.values()][0]).toMatchObject({ state: "released", recovery: "receipt" });
    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toEqual({ outcome: "conflict" });
    const withoutReceipts = createRequestIdempotency({ store, clock: new FakeClock(), leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
    expect(await withoutReceipts.claim(orderRequest({ recovery: "none" }))).toEqual({ outcome: "conflict" });
  });

  it("accepts final statuses only and no body for 204, 205 and 304", async () => {
    for (const response of [{ status: 101 }, { status: 199 }, { status: 204, body: "x" }, { status: 205, body: "" }, { status: 304, body: "x" }]) {
      expect(() => normalizeIdempotentResponse(response)).toThrow(/status/);
    }
    const { idempotency, store, database } = setup();
    const plain = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    await expect(idempotency.settle(plain, { status: 204, body: "x" })).rejects.toThrow(/must not have a body/);
    const base = { state: "completed", version: "v", generation: 1, fingerprint: plain.fingerprint, recovery: "none", expiresAt: 2_000_000 };
    for (const response of [{ status: 101, headers: {} }, { status: 304, headers: {}, body: "x" }]) {
      store.records.set(plain.storeKey, { ...base, response } as unknown as IdempotencyRecord);
      await expect(idempotency.claim(orderRequest({ recovery: "none" }))).rejects.toThrow(/malformed record/);
    }
    const token = acquired(await idempotency.claim(orderRequest({ key: "order-key-2" })));
    database.receiptsByKey.set(token.storeKey, { ...token, response: { status: 205, body: "x" } });
    await expect(idempotency.settle(token, { status: 201 })).rejects.toThrow(/malformed receipt/);
  });

  it("rejects array subclasses, extra array members and accessors in a body", () => {
    class Items extends Array<number> {}
    const withGetter = {};
    Object.defineProperty(withGetter, "item", { enumerable: true, get: () => "book" });
    const itemGetter = [0];
    Object.defineProperty(itemGetter, 0, { enumerable: true, get: () => 1 });
    for (const value of [Items.from([1]), Object.assign([1], { extra: 1 }), Object.assign([1], { [Symbol("s")]: 1 }), withGetter, itemGetter]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
      expect(() => canonicalJson({ nested: value })).toThrow(TypeError);
    }
  });

  it("never echoes body member names in canonical JSON errors", () => {
    const member = "test-sensitive-member-name";
    for (const value of [{ [member]: Number.NaN }, { [member]: [1, undefined] }, { [member]: { [member]: () => 1 } }]) {
      let message = "";
      try {
        canonicalJson(value);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/canonicalJson: .*depth/);
      expect(message).not.toContain(member);
    }
  });

  it("never stores or replays host-named credential headers", async () => {
    const { idempotency, store, database } = setup({ credentialHeaders: ["X-Session-Token"] });
    const plain = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    const response = { status: 200, headers: { "X-Session-Token": "test-session-token", "x-keep": "kept" }, body: "done" };
    // The holder's own caller gets its response unchanged.
    expect(await idempotency.settle(plain, response)).toEqual({ outcome: "settled", response });
    expect(JSON.stringify([...store.records.values()])).not.toContain("test-session-token");
    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toMatchObject({ response: { headers: { "x-keep": "kept" } } });

    // A record or receipt written elsewhere never replays it either.
    const record = store.records.get(plain.storeKey);
    if (record?.state !== "completed") throw new Error("expected a completed record");
    store.records.set(plain.storeKey, { ...record, response: { ...record.response, headers: { "x-session-token": "test-session-token" } } });
    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toMatchObject({ response: { headers: {} } });
    const holder = acquired(await idempotency.claim(orderRequest({ key: "order-key-2" })));
    database.receiptsByKey.set(holder.storeKey, { ...holder, claimId: "test-claim-other", response });
    expect(await idempotency.settle(holder, { status: 500 })).toEqual({
      outcome: "committed",
      response: { status: 200, headers: { "x-keep": "kept" }, body: "done" },
    });

    expect(normalizeIdempotentResponse(response, { credentialHeaders: ["x-session-token"] }).headers).toEqual({ "x-keep": "kept" });
    expect(() => setup({ credentialHeaders: ["bad name"] })).toThrow(TypeError);
  });

  it("validates the bound passed to normalizeIdempotentResponse", () => {
    for (const maxBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY, 16 * 1024 * 1024 + 1, "10" as unknown as number]) {
      expect(() => normalizeIdempotentResponse({ status: 200 }, { maxBytes })).toThrow(/maxBytes/);
    }
    expect(normalizeIdempotentResponse({ status: 200, body: "x" }, { maxBytes: 16 * 1024 * 1024 })).toMatchObject({ body: "x" });
  });
});

describe("createRequestIdempotency round-6 regressions", () => {
  /** A receipt source whose post-write lookup (the second call) runs `fail` and rejects. */
  function failingSecondLookup(fail: () => Promise<void> | void = () => undefined) {
    const lookupError = new Error("receipt source unavailable");
    let calls = 0;
    const receipts = {
      find: async (): Promise<IdempotencyReceipt | undefined> => {
        await tick();
        calls += 1;
        if (calls !== 2) return undefined;
        await fail();
        throw lookupError;
      },
    };
    return { receipts, lookupError };
  }

  it("frees an unused claim when the post-write receipt lookup fails, so the key is not stranded", async () => {
    const { receipts, lookupError } = failingSecondLookup();
    const { idempotency, store } = setup({ receipts });
    const none = orderRequest({ recovery: "none" });

    await expect(idempotency.claim(none)).rejects.toBe(lookupError);
    const [record] = [...store.records.values()];
    expect(record).toMatchObject({ state: "released", generation: 1 });
    // No handler ran, so the next caller acquires instead of waiting for the lease or retention.
    expect(acquired(await idempotency.claim(none)).generation).toBe(2);
  });

  it("never clears a newer writer's record after a failed post-write receipt lookup", async () => {
    let store!: FakeAtomicStore;
    const newer = { state: "pending", version: "test-version-newer", generation: 7, recovery: "none" } as const;
    const { receipts, lookupError } = failingSecondLookup(() => {
      const [[storeKey, current]] = [...store.records.entries()];
      store.records.set(storeKey, { ...current, ...newer } as IdempotencyRecord);
    });
    const context = setup({ receipts });
    store = context.store;
    const { idempotency } = context;

    await expect(idempotency.claim(orderRequest({ recovery: "none" }))).rejects.toBe(lookupError);
    expect([...store.records.values()][0]).toMatchObject(newer);
  });

  it("reports the lookup failure even when freeing the unused claim also fails", async () => {
    class FailingReleaseStore extends FakeAtomicStore {
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        if (next?.state === "released") throw new Error("store write failed");
        return super.compareAndSet(storeKey, expectedVersion, next);
      }
    }
    const { receipts, lookupError } = failingSecondLookup();
    const { idempotency } = setup({ receipts, store: new FailingReleaseStore() });
    await expect(idempotency.claim(orderRequest({ recovery: "none" }))).rejects.toBe(lookupError);
  });

  it("rejects non-ASCII header names, control characters in values and an omitted body on a bodyless status", async () => {
    const invalid: Record<string, string>[] = [{ "\u212A-name": "x" }, { "x-a": "a\u0001b" }, { "x-a": "a\u007fb" }];
    for (const headers of invalid) {
      expect(() => normalizeIdempotentResponse({ status: 200, headers })).toThrow(TypeError);
    }
    expect(normalizeIdempotentResponse({ status: 200, headers: { "X-Tab": "a\tb" } }).headers).toEqual({ "x-tab": "a\tb" });

    const { idempotency, store } = setup();
    const plain = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    const base = { state: "completed", version: "v", generation: 1, fingerprint: plain.fingerprint, recovery: "none", expiresAt: 2_000_000 };
    for (const response of [
      { status: 204, headers: {}, omitted: ["body"] },
      { status: 200, headers: { "x-a": "a\u0001b" } },
    ]) {
      store.records.set(plain.storeKey, { ...base, response } as unknown as IdempotencyRecord);
      await expect(idempotency.claim(orderRequest({ recovery: "none" }))).rejects.toThrow(/malformed record/);
    }
  });

  it("rejects a toJSON getter without invoking it", () => {
    const getter = vi.fn(() => () => "converted");
    const own = Object.defineProperty({ a: 1 }, "toJSON", { get: getter, enumerable: true });
    const inherited = Object.create(Object.defineProperty({}, "toJSON", { get: getter })) as object;
    expect(() => canonicalJson(own)).toThrow(TypeError);
    expect(() => canonicalJson(inherited)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
});

/** Atomic store where, once armed, a newer writer replaces the record just before every compare-and-set. */
class BumpingStore extends FakeAtomicStore {
  bumping = false;
  bumps = 0;
  readonly newest = new Map<string, IdempotencyRecord>();

  override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean> {
    const current = this.records.get(storeKey);
    if (this.bumping && current) {
      this.bumps += 1;
      const newer = { ...current, version: `test-version-newer-${this.bumps}` };
      this.newest.set(storeKey, newer);
      this.records.set(storeKey, structuredClone(newer));
    }
    return super.compareAndSet(storeKey, expectedVersion, next);
  }
}

describe("createRequestIdempotency round-7 regressions", () => {
  it("classifies from a validated receipt when every store write loses, and never overwrites the newer record", async () => {
    const store = new BumpingStore();
    const { idempotency, database, clock } = setup({ store });
    const own = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(own, "book");
    const otherKey = orderRequest({ key: "order-key-2" });
    const slow = acquired(await idempotency.claim(otherKey));
    clock.advance(1_001);
    const current = acquired(await idempotency.claim(otherKey));
    database.receiptsByKey.set(slow.storeKey, { ...slow, response: committed });
    const conflictKey = orderRequest({ key: "order-key-3" });
    const loser = acquired(await idempotency.claim(conflictKey));
    database.receiptsByKey.set(loser.storeKey, { ...loser, fingerprint: "test-other-body-fingerprint", response: committed });
    store.bumping = true;
    const before = structuredClone([...store.records.entries()]);
    const writes = store.writes;

    // Every record stays exactly as its newest writer wrote it: a receipt decides whether or not a write wins.
    const expectUntouched = () => {
      expect(store.writes).toBe(writes);
      for (const [key, record] of before) expect(store.records.get(key)).toEqual(store.newest.get(key) ?? record);
    };

    expect(await idempotency.settle(own, committed)).toEqual({ outcome: "settled", response: committed });
    expectUntouched();
    expect(await idempotency.settle(current, { status: 409 })).toEqual({ outcome: "committed", response: committed });
    expect(await idempotency.settle(loser, { status: 409 })).toEqual({ outcome: "conflict" });
    expect(await idempotency.release(own)).toEqual({ outcome: "committed", response: committed });
    expect(await idempotency.release(loser)).toEqual({ outcome: "conflict" });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.claim(conflictKey)).toEqual({ outcome: "conflict" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.recover(conflictKey)).toEqual({ outcome: "conflict" });
    expectUntouched();
    expect(database.orders).toEqual(["book"]);
  });

  it("delivers the receipt's replay view plus only the holder's own credential headers on its own commit", async () => {
    const { idempotency, database } = setup();
    const cookie = { "set-cookie": "session=test-session-value" };
    const probes: { extra: Record<string, string>; kept: Record<string, string> }[] = [
      { extra: { Connection: "content-encoding", "Content-Encoding": "gzip", "Set-Cookie": cookie["set-cookie"] }, kept: cookie },
      { extra: { connection: "location", location: "/orders/elsewhere" }, kept: {} },
      { extra: { "transfer-encoding": "chunked", "keep-alive": "timeout=5", "set-cookie": cookie["set-cookie"] }, kept: cookie },
      { extra: { "x-request-id": "test-request-2", "set-cookie": cookie["set-cookie"] }, kept: cookie },
      { extra: { connection: "set-cookie", "set-cookie": cookie["set-cookie"] }, kept: {} },
    ];
    for (const [index, { extra, kept }] of probes.entries()) {
      const request = orderRequest({ key: `order-key-probe-${index}` });
      const token = acquired(await idempotency.claim(request));
      const committed = await database.createOrder(token, "book");
      const result = await idempotency.settle(token, { ...committed, headers: { ...committed.headers, ...extra } });
      expect(result).toEqual({ outcome: "settled", response: { ...committed, headers: { ...committed.headers, ...kept } } });
      expect(await idempotency.claim(request)).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    }
  });

  it("runs the final lease check after the acquired diagnostic and retires a claim whose lease lapsed", async () => {
    const clock = new FakeClock();
    const events: IdempotencyDiagnostic[] = [];
    const onDiagnostic = (event: IdempotencyDiagnostic) => {
      events.push(event);
      if (event.outcome === "acquired" && events.length === 1) clock.advance(1_500); // the lease is 1_000
    };
    const { idempotency, store } = setup({ clock, onDiagnostic });
    const token = acquired(await idempotency.claim(orderRequest()));
    expect(token.generation).toBe(2);
    expect(events.map((event) => event.outcome)).toEqual(["acquired", "lease_lapsed", "acquired"]);
    expect(store.records.get(token.storeKey)).toMatchObject({ state: "pending", version: token.version });
  });

  it("rejects non-plain header maps and values above U+00FF, and keeps a __proto__ header", async () => {
    expect(() => normalizeIdempotentResponse({ status: 200, headers: new Headers({ "x-a": "1" }) as never })).toThrow(TypeError);
    class HeaderBag {
      "x-a" = "1";
    }
    expect(() => normalizeIdempotentResponse({ status: 200, headers: new HeaderBag() as never })).toThrow(TypeError);
    expect(() => normalizeIdempotentResponse({ status: 200, headers: { "x-a": "Ā" } })).toThrow(TypeError);
    expect(normalizeIdempotentResponse({ status: 200, headers: { "x-a": "café" } }).headers).toEqual({ "x-a": "café" });

    const headers = JSON.parse('{"__proto__":"test-proto-value","x-b":"2"}') as Record<string, string>;
    const stored = normalizeIdempotentResponse({ status: 200, headers });
    expect(Object.hasOwn(stored.headers, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(stored.headers)).toBe(Object.prototype);
    expect(Object.entries(stored.headers)).toEqual([["__proto__", "test-proto-value"], ["x-b", "2"]]);

    const { idempotency, store } = setup();
    const plain = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    const record = { state: "completed", version: "v", generation: 1, fingerprint: plain.fingerprint, recovery: "none", expiresAt: 2_000_000 };
    store.records.set(plain.storeKey, { ...record, response: { status: 200, headers } } as unknown as IdempotencyRecord);
    const replay = await idempotency.claim(orderRequest({ recovery: "none" }));
    if (replay.outcome !== "replay") throw new Error(`expected replay, got ${replay.outcome}`);
    expect(Object.entries(replay.response.headers)).toEqual([["__proto__", "test-proto-value"], ["x-b", "2"]]);
  });

  it("rejects symbol-keyed and non-enumerable object members", () => {
    expect(() => canonicalJson({ a: 1, [Symbol("hidden")]: 2 })).toThrow(TypeError);
    expect(() => canonicalJson(Object.defineProperty({ a: 1 }, "b", { value: 2, enumerable: false }))).toThrow(TypeError);
    expect(canonicalJson(Object.assign(Object.create(null) as object, { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });
});

/** Atomic store that commits a receipt inside a chosen pending (acquire) write, then optionally bumps the record. */
class ReceiptDuringAcquireStore extends FakeAtomicStore {
  newer: IdempotencyRecord | undefined;
  private pendingWrites = 0;
  private landed = false;

  constructor(
    private readonly land: (storeKey: string, pending: IdempotencyRecord) => void,
    private readonly options: { onPendingWrite?: number; bumpAfter?: boolean } = {},
  ) {
    super();
  }

  override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean> {
    const current = this.records.get(storeKey);
    if (this.landed && this.options.bumpAfter && current && !this.newer) {
      // A newer writer replaces the claim before the claimant records the receipt.
      this.newer = { ...current, version: "test-version-newer-writer" };
      this.records.set(storeKey, structuredClone(this.newer));
    }
    const written = await super.compareAndSet(storeKey, expectedVersion, next);
    if (written && next?.state === "pending" && (this.pendingWrites += 1) === (this.options.onPendingWrite ?? 1)) {
      this.landed = true;
      this.land(storeKey, next);
    }
    return written;
  }
}

describe("createRequestIdempotency round-8 regressions", () => {
  const committedResponse = { status: 201, headers: { "content-type": "application/json" }, body: '{"id":1}' };

  function receiptLander(database: FakeOrderDatabase, fingerprint?: string) {
    return (storeKey: string, pending: IdempotencyRecord) => {
      const commit = { storeKey, fingerprint: fingerprint ?? pending.fingerprint, generation: 1, claimId: "test-claim-other" };
      database.receiptsByKey.set(storeKey, { ...commit, response: committedResponse });
    };
  }

  it("rechecks the receipt after a receipt-mode acquire write and replays it instead of handing out a claim", async () => {
    const database = new FakeOrderDatabase();
    const store = new ReceiptDuringAcquireStore(receiptLander(database));
    const { idempotency } = setup({ store, receipts: database.receipts });

    const result = await idempotency.claim(orderRequest());
    expect(result).toEqual({ outcome: "replay", response: committedResponse, source: "receipt" });
    // The unused claim is released; the store never records the receipt.
    expect([...store.records.values()][0]).toMatchObject({ state: "released", recovery: "receipt" });
    expect(database.orders).toEqual([]);
  });

  it("reports a conflict when a receipt for another body lands during a receipt-mode acquire write", async () => {
    const database = new FakeOrderDatabase();
    const store = new ReceiptDuringAcquireStore(receiptLander(database, "test-other-body-fingerprint"));
    const { idempotency } = setup({ store, receipts: database.receipts });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "conflict" });
  });

  it("rechecks the receipt after a takeover write of an expired receipt-mode claim", async () => {
    const database = new FakeOrderDatabase();
    const store = new ReceiptDuringAcquireStore(receiptLander(database), { onPendingWrite: 2 });
    const { idempotency, clock } = setup({ store, receipts: database.receipts });
    const slow = acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);
    const result = await idempotency.claim(orderRequest());
    expect(result).toMatchObject({ outcome: "replay", source: "receipt" });
    expect([...store.records.values()][0]).toMatchObject({ state: "released", recovery: "receipt", generation: 2 });
    expect(slow.generation).toBe(1);
  });

  it("leaves a newer writer untouched when recording a receipt found after the acquire write", async () => {
    const database = new FakeOrderDatabase();
    const store = new ReceiptDuringAcquireStore(receiptLander(database), { bumpAfter: true });
    const { idempotency } = setup({ store, receipts: database.receipts });
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    expect([...store.records.values()][0]).toEqual(store.newer);
  });

  it("frees a receipt-mode claim when the post-write receipt lookup fails", async () => {
    const lookupError = new Error("receipt source unavailable");
    let calls = 0;
    const receipts = {
      find: async (): Promise<IdempotencyReceipt | undefined> => {
        await tick();
        calls += 1;
        if (calls === 2) throw lookupError;
        return undefined;
      },
    };
    const { idempotency, store } = setup({ receipts });
    await expect(idempotency.claim(orderRequest())).rejects.toBe(lookupError);
    expect([...store.records.values()][0]).toMatchObject({ state: "released", generation: 1, recovery: "receipt" });
    expect(acquired(await idempotency.claim(orderRequest())).generation).toBe(2);
  });

  it("frees a claim whose acquire write landed but whose acknowledgement was lost", async () => {
    const writeError = new Error("store acknowledgement lost");
    class LostAckStore extends FakeAtomicStore {
      failed = false;
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        const written = await super.compareAndSet(storeKey, expectedVersion, next);
        if (!this.failed && next?.state === "pending") {
          this.failed = true;
          throw writeError;
        }
        return written;
      }
    }
    for (const recovery of ["receipt", "none"] as const) {
      const store = new LostAckStore();
      const { idempotency } = setup({ store });
      await expect(idempotency.claim(orderRequest({ recovery }))).rejects.toBe(writeError);
      expect([...store.records.values()][0]).toMatchObject({ state: "released", generation: 1, recovery });
      expect(acquired(await idempotency.claim(orderRequest({ recovery }))).generation).toBe(2);
    }
  });

  it("leaves the prior record unchanged when the acquire write throws without writing", async () => {
    const writeError = new Error("store unavailable");
    class FailingWriteStore extends FakeAtomicStore {
      failing = false;
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        if (this.failing && next?.state === "pending") throw writeError;
        return super.compareAndSet(storeKey, expectedVersion, next);
      }
    }
    const store = new FailingWriteStore();
    const { idempotency, clock } = setup({ store });
    acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);
    const prior = structuredClone([...store.records.values()][0]);
    store.failing = true;
    await expect(idempotency.claim(orderRequest())).rejects.toBe(writeError);
    expect([...store.records.values()][0]).toEqual(prior);
  });

  it("classifies from a validated receipt when recording it in the store throws", async () => {
    class FailingCompleteStore extends FakeAtomicStore {
      failing = false;
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        if (this.failing && next?.state === "completed") throw new Error("store write failed");
        return super.compareAndSet(storeKey, expectedVersion, next);
      }
    }
    const store = new FailingCompleteStore();
    const { idempotency, database } = setup({ store });
    const token = acquired(await idempotency.claim(orderRequest()));
    const response = await database.createOrder(token, "book");
    store.failing = true;
    expect(await idempotency.settle(token, response)).toEqual({ outcome: "settled", response });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response, source: "receipt" });
  });
});

/** Atomic store whose reads return the stored object itself, so its accessors reach the library unchanged. */
class RawReadStore extends FakeAtomicStore {
  override async get(storeKey: string): Promise<IdempotencyRecord | undefined> {
    await tick();
    return this.records.get(storeKey);
  }
}

/** A header map whose field is a getter: valid on its first read, a header injection on every later read. */
function flippingHeaders(name: string, base: Record<string, string> = {}) {
  const probe = { calls: 0, headers: { ...base } as Record<string, string> };
  Object.defineProperty(probe.headers, name, {
    enumerable: true,
    get: () => ((probe.calls += 1) === 1 ? "test-value" : "test-value\r\nx-injected: 1"),
  });
  return probe;
}

describe("createRequestIdempotency round-9 regressions", () => {
  it("never lets a stale holder's receipt touch a newer claim after the key's retention ended", async () => {
    const database = new FakeOrderDatabase();
    const store = new FakeAtomicStore();
    let hook: (() => Promise<void>) | undefined;
    const receipts = {
      find: async (storeKey: string) => {
        const found = await database.receipts.find(storeKey);
        const run = hook;
        hook = undefined;
        // Between the stale holder's receipt read and its next step, retention ends and a newer claim starts.
        if (run) await run();
        return found;
      },
    };
    const { idempotency } = setup({ store, receipts });
    const stale = acquired(await idempotency.claim(orderRequest()));
    const response = await database.createOrder(stale, "book");
    let newer: IdempotencyToken | undefined;
    let newerRecord: IdempotencyRecord | undefined;
    hook = async () => {
      database.receiptsByKey.clear();
      store.records.clear();
      newer = acquired(await idempotency.claim(orderRequest()));
      newerRecord = structuredClone(store.records.get(newer.storeKey));
    };

    // The holder's write loses to the newer claim and its receipt is gone by then: stale, and the newer claim is untouched.
    expect(await idempotency.settle(stale, response)).toEqual({ outcome: "stale" });
    expect(newer).toBeDefined();
    expect(store.records.get(stale.storeKey)).toEqual(newerRecord);

    const newerResponse = await database.createOrder(newer!, "book");
    expect(await idempotency.settle(newer!, newerResponse)).toEqual({ outcome: "settled", response: newerResponse });
    expect(store.records.get(stale.storeKey)).toMatchObject({ state: "completed", generation: newerRecord!.generation, response: newerResponse });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: newerResponse, source: "receipt" });
  });

  it("replays a newer commit of the same body over an older settled record, and never writes over that record", async () => {
    const { idempotency, database, store } = setup();
    const first = acquired(await idempotency.claim(orderRequest()));
    await idempotency.settle(first, await database.createOrder(first, "book"));
    const recorded = structuredClone(store.records.get(first.storeKey));
    expect(recorded).toMatchObject({ state: "completed", generation: first.generation });
    // The receipt store purged the first commit and a later claim of the same body committed again.
    database.receiptsByKey.clear();
    const later = { ...first, version: "test-version-later", claimId: "test-claim-later" };
    const laterResponse = await database.createOrder(later, "book again");

    expect(await idempotency.settle(later, laterResponse)).toEqual({ outcome: "settled", response: laterResponse });
    expect(store.records.get(first.storeKey)).toEqual(recorded);
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: laterResponse, source: "receipt" });
  });

  it("rejects an accessor-backed connection header in normalize without invoking it", () => {
    const probe = flippingHeaders("connection", { "x-note": "test-value" });
    expect(() => normalizeIdempotentResponse({ status: 200, headers: probe.headers })).toThrow(TypeError);
    expect(probe.calls).toBe(0);
  });

  it("never copies an accessor-backed set-cookie into the holder's own receipt-backed settle", async () => {
    const { idempotency, database } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(token, "book");
    const probe = flippingHeaders("set-cookie", committed.headers);
    const result = await idempotency.settle(token, { ...committed, headers: probe.headers });
    expect(result).toEqual({ outcome: "settled", response: committed });
    expect(probe.calls).toBe(0);
  });

  it("fails closed on a stored record whose header is an accessor, without invoking it", async () => {
    const store = new RawReadStore();
    const { idempotency } = setup({ store });
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    await idempotency.settle(token, { status: 200, headers: { "x-note": "test-value" } });
    const record = store.records.get(token.storeKey) as IdempotencyRecord & { response: { headers: Record<string, string> } };
    const probe = flippingHeaders("x-note");
    record.response.headers = probe.headers;

    await expect(idempotency.claim(orderRequest({ recovery: "none" }))).rejects.toThrow(/malformed record/);
    await expect(idempotency.recover(orderRequest({ recovery: "none" }))).rejects.toThrow(/malformed record/);
    expect(probe.calls).toBe(0);
  });

  it("settles without a receipt from the response as validated, never the caller's later changes", async () => {
    const store = new HookedStore();
    const { idempotency } = setup({ store });
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    const response = { status: 201, headers: { "x-note": "test-value", "set-cookie": "test-session=1" } as Record<string, string>, body: "{}" };
    store.arm(token.version, async () => {
      // The caller changes its object while the settle write is in flight.
      response.status = 500;
      response.headers["x-note"] = "test-value\r\nx-injected: 1";
    });

    const result = await idempotency.settle(token, response);
    expect(result).toEqual({
      outcome: "settled",
      response: { status: 201, headers: { "x-note": "test-value", "set-cookie": "test-session=1" }, body: "{}" },
    });
    if (result.outcome === "settled") expect(result.response).not.toBe(response);
    expect(store.records.get(token.storeKey)).toMatchObject({ response: { status: 201, headers: { "x-note": "test-value" } } });
  });

  it("rejects an accessor-backed header on settle without a receipt before any store write", async () => {
    const { idempotency, store } = setup();
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
    const pending = structuredClone(store.records.get(token.storeKey));
    const probe = flippingHeaders("x-note");
    await expect(idempotency.settle(token, { status: 200, headers: probe.headers })).rejects.toThrow(TypeError);
    expect(probe.calls).toBe(0);
    expect(store.records.get(token.storeKey)).toEqual(pending);
  });

  it("reports a conflict when the tombstone write of a none claim that found a receipt rejects", async () => {
    const database = new FakeOrderDatabase();
    class FailingTombstoneStore extends ReceiptDuringAcquireStore {
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        if (next?.state === "released") throw new Error("store write failed");
        return super.compareAndSet(storeKey, expectedVersion, next);
      }
    }
    const store = new FailingTombstoneStore((storeKey, pending) => {
      const commit = { storeKey, fingerprint: pending.fingerprint, generation: 1, claimId: "test-claim-other" };
      database.receiptsByKey.set(storeKey, { ...commit, response: { status: 201, headers: {}, body: "{}" } });
    });
    const { idempotency } = setup({ store, receipts: database.receipts });

    expect(await idempotency.claim(orderRequest({ recovery: "none" }))).toEqual({ outcome: "conflict" });
    expect([...store.records.values()][0]).toMatchObject({ state: "pending", recovery: "none", generation: 1 });
    expect(store.writes).toBe(1);
  });
});

/** Receipt source whose next lookup reads the receipt, then pauses on a hook before it returns. */
function pausingReceipts(database: FakeOrderDatabase) {
  let hook: (() => Promise<void>) | undefined;
  return {
    receipts: {
      find: async (storeKey: string) => {
        const found = await database.receipts.find(storeKey);
        const run = hook;
        hook = undefined;
        if (run) await run();
        return found;
      },
    },
    pauseNext(run: () => Promise<void>) {
      hook = run;
    },
  };
}


/** Atomic store that logs every compare-and-set: the version it expected and the state it wrote. */
class SpyStore extends FakeAtomicStore {
  readonly log: { expectedVersion: string | null; state: IdempotencyRecord["state"] | null; written: boolean }[] = [];
  failing = false;

  override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean> {
    if (this.failing) throw new Error("store write failed");
    const written = await super.compareAndSet(storeKey, expectedVersion, next);
    this.log.push({ expectedVersion, state: next?.state ?? null, written });
    return written;
  }
}

/** A receipt source that can be switched to reject every lookup (an outage) or to return a malformed receipt. */
function switchableReceipts(database: FakeOrderDatabase) {
  const state: { mode: "ok" | "outage" | "malformed" } = { mode: "ok" };
  const receipts: IdempotencyReceiptSource = {
    find: async (storeKey) => {
      if (state.mode === "outage") throw new Error("receipt source unavailable");
      const found = await database.receipts.find(storeKey);
      return state.mode === "malformed" && found ? ({ ...found, response: { status: 99 } } as IdempotencyReceipt) : found;
    },
  };
  return { state, receipts };
}

describe("createRequestIdempotency PR round-5 architecture reset: the receipt is the only commit evidence", () => {
  const otherBody = { item: "pen", quantity: 2 };

  function world(store: FakeAtomicStore = new SpyStore()) {
    const database = new FakeOrderDatabase();
    const source = switchableReceipts(database);
    const clock = new FakeClock();
    const options = { store, receipts: source.receipts, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce };
    return { store, database, source, clock, idempotency: createRequestIdempotency(options) };
  }

  it("V1: the source keeps no receipt copy markers", () => {
    const source = readFileSync(fileURLToPath(new URL("../request-idempotency.ts", import.meta.url)), "utf8");
    // Built at runtime, so this file never names them either.
    for (const marker of [["from", "Receipt"], ["provi", "sional"], ["receipt", "ClaimId"]]) {
      expect(source).not.toContain(marker.join(""));
    }
  });

  it("V1: claim and recover over a present receipt make no store write; only claims and their holders write", async () => {
    const store = new SpyStore();
    const { idempotency, database, clock } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(holder, "book");
    const writes = store.log.length;

    for (const body of [orderRequest().body, otherBody]) {
      await idempotency.claim(orderRequest({ body }));
      await idempotency.recover(orderRequest({ body }));
    }
    clock.advance(1_001); // the holder's lease expires: the receipt still decides, with no takeover write
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.claim(orderRequest({ body: otherBody }))).toEqual({ outcome: "conflict" });
    expect(store.log.length).toBe(writes);

    // The holder's settle records the result it reports over its own version; a later release writes nothing.
    expect(await idempotency.settle(holder, { status: 500 })).toEqual({ outcome: "settled", response: committed });
    expect(await idempotency.release(holder)).toEqual({ outcome: "committed", response: committed });
    expect(store.log.length).toBe(writes + 1);

    // Every write was an acquire (pending), a holder's settle (completed) or a release (released), each over the
    // version its claim saw or wrote.
    const other = orderRequest({ key: "order-key-2" });
    const settled = acquired(await idempotency.claim(other));
    await idempotency.settle(settled, { status: 422, body: "rejected" });
    const released = acquired(await idempotency.claim(orderRequest({ key: "order-key-3" })));
    await idempotency.release(released);
    expect(store.log).toEqual([
      { expectedVersion: null, state: "pending", written: true },
      { expectedVersion: holder.version, state: "completed", written: true },
      { expectedVersion: null, state: "pending", written: true },
      { expectedVersion: settled.version, state: "completed", written: true },
      { expectedVersion: null, state: "pending", written: true },
      { expectedVersion: released.version, state: "released", written: true },
    ]);
  });

  it("V1: a stored completed record that carries anything but a holder's settle fields fails closed", async () => {
    const { idempotency, store } = world(new FakeAtomicStore());
    const token = acquired(await idempotency.claim(orderRequest()));
    await idempotency.settle(token, { status: 200, body: "done" });
    const settled = store.records.get(token.storeKey)!;
    // Field names of the receipt copies an earlier build wrote, built at runtime.
    const legacy = [{ [["from", "Receipt"].join("")]: true, [["receipt", "ClaimId"].join("")]: "test-claim" }, { [["provi", "sional"].join("")]: true }, { extra: 1 }];
    for (const fields of legacy) {
      store.records.set(token.storeKey, { ...settled, ...fields } as IdempotencyRecord);
      await expect(idempotency.claim(orderRequest())).rejects.toThrow("malformed record");
      await expect(idempotency.recover(orderRequest())).rejects.toThrow("malformed record");
    }
  });

  it("V2a: a pruned receipt frees the key only when no holder-settled record exists, and never while it is readable", async () => {
    const { idempotency, database, clock } = world();
    const holder = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(holder, "book");
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    clock.advance(1_001);
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });

    // The receipt's retention is the replay window: once the host prunes it, the expired claim is free.
    database.receiptsByKey.clear();
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "not_committed" });
    expect(acquired(await idempotency.claim(orderRequest())).generation).toBe(holder.generation + 1);

    // A holder-settled record keeps its own result after a prune, until its own retention ends.
    const other = orderRequest({ key: "order-key-2" });
    const settledHolder = acquired(await idempotency.claim(other));
    await idempotency.settle(settledHolder, { status: 422, body: "rejected" });
    database.receiptsByKey.clear();
    expect(await idempotency.claim(other)).toMatchObject({ outcome: "replay", source: "store", response: { status: 422 } });
    clock.advance(60_000);
    expect(await idempotency.claim(other)).toMatchObject({ outcome: "acquired" });
  });

  it("V2b: after receipt A is pruned and commit B is evicted, claim and recover decide from the receipt read now, never from A", async () => {
    const { idempotency, database, store, source } = world();
    const first = acquired(await idempotency.claim(orderRequest()));
    const firstResponse = await database.createOrder(first, "book");
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: firstResponse, source: "receipt" });

    database.receiptsByKey.clear();
    store.records.clear();
    const newer = acquired(await idempotency.claim(orderRequest({ body: otherBody })));
    const newerResponse = await database.createOrder(newer, "pen");
    expect(await idempotency.settle(newer, newerResponse)).toEqual({ outcome: "settled", response: newerResponse });
    store.records.clear();

    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "conflict" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "conflict" });
    expect(await idempotency.claim(orderRequest({ body: otherBody }))).toEqual({ outcome: "replay", response: newerResponse, source: "receipt" });
    expect(await idempotency.settle(first, firstResponse)).toEqual({ outcome: "conflict" });
    expect(await idempotency.release(first)).toEqual({ outcome: "conflict" });

    // During an outage nothing in the store stands in for either receipt.
    source.state.mode = "outage";
    for (const body of [orderRequest().body, otherBody]) {
      await expect(idempotency.claim(orderRequest({ body }))).rejects.toThrow("receipt source unavailable");
      await expect(idempotency.recover(orderRequest({ body }))).rejects.toThrow("receipt source unavailable");
    }
    expect(database.orders).toEqual(["book", "pen"]);
  });

  it.each([
    ["another body", "conflict"],
    ["the same body, pruned before the read", "stale"],
  ] as const)("V2c: settle and release whose write loses to a newer commit of %s report %s", async (bodyCase, expected) => {
    for (const finish of ["settle", "release"] as const) {
      const store = new HookedStore();
      const { idempotency, database, clock } = world(store);
      const slow = acquired(await idempotency.claim(orderRequest()));
      clock.advance(60_000); // the holder's retention ends while it still runs, so any body may claim the key
      const body = bodyCase === "another body" ? otherBody : orderRequest().body;
      store.arm(slow.version, async () => {
        // During the holder's write a newer claim takes the expired key and commits.
        const newer = acquired(await idempotency.claim(orderRequest({ body })));
        await database.createOrder(newer, "newer");
        if (bodyCase !== "another body") {
          database.receiptsByKey.clear();
          store.records.clear();
        }
      });
      const result = finish === "settle" ? await idempotency.settle(slow, { status: 200 }) : await idempotency.release(slow);
      expect(result).toEqual({ outcome: expected });
      if (expected === "stale") {
        expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "absent" });
        expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "acquired" });
      }
    }
  });

  it("V2d: a store that rejects every write never hides a validated receipt from claim, recover, settle or release", async () => {
    const store = new SpyStore();
    const { idempotency, database } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(holder, "book");
    store.failing = true;

    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.claim(orderRequest({ body: otherBody }))).toEqual({ outcome: "conflict" });
    expect(await idempotency.settle(holder, committed)).toEqual({ outcome: "settled", response: committed });
    expect(await idempotency.release(holder)).toEqual({ outcome: "committed", response: committed });
  });

  it("V4 (amended): a receipt-source outage throws, except over a record settled from the holder's own receipt, until its own deadline", async () => {
    const { idempotency, database, source, clock, store } = world(new FakeAtomicStore());
    const pending = acquired(await idempotency.claim(orderRequest()));
    const settledRequest = orderRequest({ key: "order-key-2" });
    const settledHolder = acquired(await idempotency.claim(settledRequest));
    const settledResponse = await database.createOrder(settledHolder, "pen");
    expect(await idempotency.settle(settledHolder, { status: 500 })).toEqual({ outcome: "settled", response: settledResponse });
    expect(store.records.get(settledHolder.storeKey)).toMatchObject({ state: "completed", receiptSettled: true });
    // A fallback settled without a receipt is not flagged: it never stands in for the source.
    const fallbackRequest = orderRequest({ key: "order-key-5" });
    const fallbackHolder = acquired(await idempotency.claim(fallbackRequest));
    expect(await idempotency.settle(fallbackHolder, { status: 422, body: "rejected" })).toMatchObject({ outcome: "settled" });
    expect(store.records.get(fallbackHolder.storeKey)).not.toHaveProperty("receiptSettled");
    const released = acquired(await idempotency.claim(orderRequest({ key: "order-key-3" })));
    expect(await idempotency.release(released)).toEqual({ outcome: "released" });
    await database.createOrder(pending, "book");

    source.state.mode = "outage";
    for (const request of [orderRequest(), fallbackRequest, orderRequest({ key: "order-key-3" }), orderRequest({ key: "order-key-4" })]) {
      await expect(idempotency.claim(request)).rejects.toThrow("receipt source unavailable");
      await expect(idempotency.recover(request)).rejects.toThrow("receipt source unavailable");
    }
    await expect(idempotency.settle(pending, { status: 200 })).rejects.toThrow("receipt source unavailable");
    await expect(idempotency.release(pending)).rejects.toThrow("receipt source unavailable");
    expect(await idempotency.claim(settledRequest)).toEqual({ outcome: "replay", response: settledResponse, source: "store" });
    expect(await idempotency.recover(settledRequest)).toEqual({ outcome: "replay", response: settledResponse, source: "store" });
    expect(await idempotency.claim(orderRequest({ key: "order-key-2", body: otherBody }))).toEqual({ outcome: "conflict" });
    clock.advance(60_000);
    await expect(idempotency.claim(settledRequest)).rejects.toThrow("receipt source unavailable");
    expect(database.orders).toEqual(["pen", "book"]);
  });

  it("V4: settle throws when the receipt read after its won write fails, and its settled record then replays", async () => {
    const database = new FakeOrderDatabase();
    let reads = 0;
    const receipts: IdempotencyReceiptSource = {
      find: async (storeKey) => {
        reads += 1;
        if (reads === 4) throw new Error("receipt source unavailable");
        return database.receipts.find(storeKey);
      },
    };
    const { idempotency } = setup({ receipts });
    // Reads 1 (inspect) and 2 (acquire recheck); settle reads 3 before its write and 4 after it.
    const token = acquired(await idempotency.claim(orderRequest()));
    await expect(idempotency.settle(token, { status: 422, body: "rejected" })).rejects.toThrow("receipt source unavailable");
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "store", response: { status: 422 } });
  });

  it("fails closed on a receipt that fails validation, also over a holder-settled record", async () => {
    const { idempotency, database, source } = world();
    const token = acquired(await idempotency.claim(orderRequest()));
    await idempotency.settle(token, { status: 422, body: "rejected" });
    database.receiptsByKey.set(token.storeKey, { ...token, response: { status: 201, body: "late" } });
    source.state.mode = "malformed";
    await expect(idempotency.claim(orderRequest())).rejects.toThrow("malformed receipt");
    await expect(idempotency.recover(orderRequest())).rejects.toThrow("malformed receipt");
    database.receiptsByKey.set(token.storeKey, { ...token, storeKey: "test-other-store-key", response: { status: 201 } });
    source.state.mode = "ok";
    await expect(idempotency.claim(orderRequest())).rejects.toThrow("different key");
    await expect(idempotency.recover(orderRequest())).rejects.toThrow("different key");
  });
});

/** Atomic store that runs a hook after the first claim write and another before the first release write. */
class EpochDuringCleanupStore extends FakeAtomicStore {
  onAcquire?: (storeKey: string, next: IdempotencyRecord) => void;
  onComplete?: (storeKey: string) => void;
  onCleanup?: () => Promise<void>;
  /** Whether the paused release write then rejects instead of reporting its result. */
  cleanupRejects = false;

  override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean> {
    const cleanup = next?.state === "released" ? this.onCleanup : undefined;
    if (cleanup) {
      this.onCleanup = undefined;
      await cleanup();
      if (this.cleanupRejects) throw new Error("store write failed");
    }
    const written = await super.compareAndSet(storeKey, expectedVersion, next);
    const acquire = next?.state === "pending" ? this.onAcquire : undefined;
    if (acquire && next) {
      this.onAcquire = undefined;
      acquire(storeKey, next);
    }
    const complete = next?.state === "completed" ? this.onComplete : undefined;
    if (complete) {
      this.onComplete = undefined;
      complete(storeKey);
    }
    return written;
  }
}

describe("createRequestIdempotency PR round-5 delta regressions", () => {
  const otherBody = { item: "pen", quantity: 2 };
  const earlier = { status: 201, headers: { "content-type": "text/plain" }, body: "earlier commit" };

  it("keeps a settled commit replaying after its receipt is pruned, until the settled record's own retention ends", async () => {
    const { idempotency, database, clock } = setup();
    const holder = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(holder, "book");
    expect(await idempotency.settle(holder, { status: 500 })).toEqual({ outcome: "settled", response: committed });
    clock.advance(1_001);
    database.receiptsByKey.clear();

    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "store" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "store" });
    expect(await idempotency.claim(orderRequest({ body: otherBody }))).toEqual({ outcome: "conflict" });
    expect(await idempotency.release(holder)).toEqual({ outcome: "stale" });
    expect(await idempotency.settle(holder, { status: 500 })).toEqual({ outcome: "stale" });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "store" });
    expect(database.orders).toEqual(["book"]);
  });

  it.each([
    ["the same body", "committed"],
    ["another body", "conflict"],
  ] as const)("retires its settled fallback when another commit of %s lands during the write", async (bodyCase, expected) => {
    const store = new HookedStore();
    const database = new FakeOrderDatabase();
    const source = switchableReceipts(database);
    const { idempotency } = setup({ store, receipts: source.receipts });
    const holder = acquired(await idempotency.claim(orderRequest()));
    store.arm(holder.version, async () => {
      // An expired earlier holder commits while this holder writes its fallback.
      const fingerprint = bodyCase === "the same body" ? holder.fingerprint : "test-other-body-fingerprint";
      database.receiptsByKey.set(holder.storeKey, { ...holder, fingerprint, claimId: "test-claim-earlier", response: earlier });
    });

    const result = await idempotency.settle(holder, { status: 503, body: "fallback" });
    expect(result).toEqual(expected === "committed" ? { outcome: "committed", response: earlier } : { outcome: "conflict" });
    expect(store.records.get(holder.storeKey)).toMatchObject({ state: "released", recovery: "receipt" });

    // The fallback never replays: an outage throws, and once the receipt is pruned the key is free.
    source.state.mode = "outage";
    await expect(idempotency.claim(orderRequest())).rejects.toThrow("receipt source unavailable");
    source.state.mode = "ok";
    database.receiptsByKey.clear();
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "acquired" });
  });

  it.each([
    ["the same body", "replay"],
    ["another body", "conflict"],
  ] as const)("decides from the newer commit (%s) when releasing its unused claim loses to a later retention epoch", async (bodyCase, expected) => {
    for (const cleanupRejects of [false, true]) await cleanupRace(bodyCase, expected, cleanupRejects);
  });

  async function cleanupRace(bodyCase: "the same body" | "another body", expected: "replay" | "conflict", cleanupRejects: boolean) {
    const store = new EpochDuringCleanupStore();
    store.cleanupRejects = cleanupRejects;
    const database = new FakeOrderDatabase();
    const clock = new FakeClock();
    const { idempotency } = setup({ store, receipts: database.receipts, clock });
    store.onAcquire = (storeKey, next) => {
      // Receipt A lands during the claim write.
      database.receiptsByKey.set(storeKey, { storeKey, fingerprint: next.fingerprint, generation: 1, claimId: "test-claim-a", response: earlier });
    };
    let newer: IdempotencyToken | undefined;
    let newerResponse: IdempotentResponse | undefined;
    store.onCleanup = async () => {
      // Before the cleanup write: retention ends, A is pruned, the claim is evicted and B claims and commits.
      clock.advance(60_001);
      database.receiptsByKey.clear();
      store.records.clear();
      newer = acquired(await idempotency.claim(orderRequest(bodyCase === "the same body" ? {} : { body: otherBody })));
      newerResponse = await database.createOrder(newer, "newer");
    };

    const result = await idempotency.claim(orderRequest());
    expect(result).toEqual(expected === "replay" ? { outcome: "replay", response: newerResponse, source: "receipt" } : { outcome: "conflict" });
    expect(store.records.get(newer!.storeKey)).toMatchObject({ state: "pending", version: newer!.version });
    expect(database.receiptsByKey.get(newer!.storeKey)).toMatchObject({ claimId: newer!.claimId });
  }

  it("treats a receipt with the token's claim but another body as another commit, and writes nothing", async () => {
    const { idempotency, database, store } = setup();
    const holder = acquired(await idempotency.claim(orderRequest()));
    const recorded = structuredClone(store.records.get(holder.storeKey));
    database.receiptsByKey.set(holder.storeKey, { ...holder, fingerprint: "test-other-body-fingerprint", response: earlier });
    expect(await idempotency.settle(holder, { status: 201 })).toEqual({ outcome: "conflict" });
    expect(store.records.get(holder.storeKey)).toEqual(recorded);
  });

  it("reports settled when its write over its own commit applied but lost its acknowledgement and the receipt was then pruned", async () => {
    class LostAckStore extends FakeAtomicStore {
      onComplete?: () => void;
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        const written = await super.compareAndSet(storeKey, expectedVersion, next);
        const run = next?.state === "completed" ? this.onComplete : undefined;
        if (run) {
          this.onComplete = undefined;
          run();
          throw new Error("store acknowledgement lost");
        }
        return written;
      }
    }
    const store = new LostAckStore();
    const { idempotency, database } = setup({ store });
    const holder = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(holder, "book");
    store.onComplete = () => database.receiptsByKey.clear();
    expect(await idempotency.settle(holder, committed)).toEqual({ outcome: "settled", response: committed });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "store" });
  });

  it("records the holder's own commit that became visible during its fallback write, so it replays after a prune", async () => {
    const store = new HookedStore();
    const { idempotency, database } = setup({ store });
    const holder = acquired(await idempotency.claim(orderRequest()));
    let committed: IdempotentResponse | undefined;
    store.arm(holder.version, async () => {
      committed = await database.createOrder(holder, "book");
    });
    expect(await idempotency.settle(holder, { status: 503, body: "fallback" })).toEqual({ outcome: "settled", response: committed });
    database.receiptsByKey.clear();
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "store" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "store" });
  });

  it.each([
    ["the same body", "committed"],
    ["another body", "conflict"],
  ] as const)("reads the receipt again when retiring its fallback loses to a later epoch's commit of %s", async (bodyCase, expected) => {
    const store = new EpochDuringCleanupStore();
    const database = new FakeOrderDatabase();
    const clock = new FakeClock();
    const { idempotency } = setup({ store, receipts: database.receipts, clock });
    const holder = acquired(await idempotency.claim(orderRequest()));
    // A late commit A of another body lands during the fallback write.
    store.onComplete = (storeKey) =>
      database.receiptsByKey.set(storeKey, { ...holder, fingerprint: "test-other-body-fingerprint", claimId: "test-claim-a", response: earlier });
    let newer: IdempotencyToken | undefined;
    let newerResponse: IdempotentResponse | undefined;
    store.onCleanup = async () => {
      // Before the retire write: retention ends, A is pruned, the record is evicted and B claims and commits.
      clock.advance(60_001);
      database.receiptsByKey.clear();
      store.records.clear();
      newer = acquired(await idempotency.claim(orderRequest(bodyCase === "the same body" ? {} : { body: otherBody })));
      newerResponse = await database.createOrder(newer, "newer");
    };
    const result = await idempotency.settle(holder, { status: 503, body: "fallback" });
    expect(result).toEqual(expected === "committed" ? { outcome: "committed", response: newerResponse } : { outcome: "conflict" });
    expect(store.records.get(holder.storeKey)).toMatchObject({ state: "pending", version: newer!.version });
  });
});

type WriteRule = {
  match: (expectedVersion: string | null, next: IdempotencyRecord | null) => boolean;
  before?: () => unknown;
  /** Rejects the write after applying it, or without applying it. */
  reject?: "applied" | "not applied";
};

/** Atomic store whose first write matching a rule runs the rule's hook first and may then reject. */
class ScriptedStore extends FakeAtomicStore {
  readonly rules: WriteRule[] = [];

  override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean> {
    const index = this.rules.findIndex((rule) => rule.match(expectedVersion, next));
    if (index < 0) return super.compareAndSet(storeKey, expectedVersion, next);
    const [rule] = this.rules.splice(index, 1);
    await rule!.before?.();
    if (!rule!.reject) return super.compareAndSet(storeKey, expectedVersion, next);
    if (rule!.reject === "applied") await super.compareAndSet(storeKey, expectedVersion, next);
    throw new Error("store write failed");
  }
}

describe("createRequestIdempotency PR round-6 receipt provenance", () => {
  const otherBody = { item: "pen", quantity: 2 };
  const earlier = { status: 201, headers: { "content-type": "text/plain" }, body: "earlier commit" };

  function world(store: FakeAtomicStore) {
    const database = new FakeOrderDatabase();
    const source = switchableReceipts(database);
    const clock = new FakeClock();
    const options = { store, receipts: source.receipts, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce };
    return { store, database, source, clock, idempotency: createRequestIdempotency(options) };
  }

  it("R1: a takeover's fallback contradicted by a late commit replays the commit, and never during an outage", async () => {
    const { idempotency, database, source, clock } = world(new FakeAtomicStore());
    const first = acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);
    const takeover = acquired(await idempotency.claim(orderRequest()));
    expect(await idempotency.settle(takeover, { status: 503, body: "fallback" })).toMatchObject({ outcome: "settled", response: { status: 503 } });
    const late = await database.createOrder(first, "book");

    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: late, source: "receipt" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: late, source: "receipt" });
    source.state.mode = "outage";
    await expect(idempotency.claim(orderRequest())).rejects.toThrow("receipt source unavailable");
    await expect(idempotency.recover(orderRequest())).rejects.toThrow("receipt source unavailable");
  });

  it.each([
    ["the holder's own late commit", "applied"],
    ["the holder's own late commit", "not applied"],
    ["an earlier commit of the same body", "applied"],
    ["an earlier commit of the same body", "not applied"],
    ["an earlier commit of another body", "applied"],
    ["an earlier commit of another body", "not applied"],
  ] as const)("R2: a rejected fallback replacement over %s (%s) reports the receipt once applied, and fails closed otherwise", async (commit, reject) => {
    const store = new ScriptedStore();
    const { idempotency, database, source } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    let committed: IdempotentResponse | undefined;
    store.rules.push(
      {
        match: (expectedVersion) => expectedVersion === holder.version,
        before: async () => {
          if (commit === "the holder's own late commit") committed = await database.createOrder(holder, "book");
          else {
            const fingerprint = commit === "an earlier commit of the same body" ? holder.fingerprint : "test-other-body-fingerprint";
            database.receiptsByKey.set(holder.storeKey, { ...holder, fingerprint, claimId: "test-claim-earlier", response: earlier });
          }
        },
      },
      { match: (expectedVersion) => expectedVersion !== null && expectedVersion !== holder.version, reject },
    );

    const run = idempotency.settle(holder, { status: 503, body: "fallback" });
    // Round 7: a contradicted fallback the store still holds live is never reported over; settle throws the write's error.
    if (reject === "not applied") await expect(run).rejects.toThrow("store write failed");
    else if (commit === "the holder's own late commit") expect(await run).toEqual({ outcome: "settled", response: committed });
    else if (commit === "an earlier commit of the same body") expect(await run).toEqual({ outcome: "committed", response: earlier });
    else expect(await run).toEqual({ outcome: "conflict" });
    expect(store.rules).toEqual([]);

    // The fallback never replays during an outage: only an applied replacement by the holder's own commit does.
    source.state.mode = "outage";
    if (commit === "the holder's own late commit" && reject === "applied") {
      expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "store" });
    } else {
      await expect(idempotency.claim(orderRequest())).rejects.toThrow("receipt source unavailable");
    }
  });

  it("R3: a settle whose write lost to a takeover writes nothing, so its commit replays only while the receipt is retained", async () => {
    const { idempotency, database, clock, store } = world(new FakeAtomicStore());
    const holder = acquired(await idempotency.claim(orderRequest()));
    clock.advance(1_001);
    const takeover = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(holder, "book");
    expect(await idempotency.settle(holder, committed)).toEqual({ outcome: "settled", response: committed });
    expect(store.records.get(holder.storeKey)).toMatchObject({ state: "pending", version: takeover.version });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });

    // The documented boundary: once the receipt is pruned and the takeover's lease expires, the key is free.
    database.receiptsByKey.clear();
    clock.advance(1_001);
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "not_committed" });
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "acquired" });
  });

  it.each(
    (["settle", "release"] as const).flatMap((finish) =>
      (["applied", "not applied"] as const).flatMap((reject) =>
        (["the holder's own commit", "the same body", "another body", "no receipt"] as const).map((landed) => [finish, reject, landed] as const),
      ),
    ),
  )("R4: a rejected %s write (%s) while %s lands decides from the receipt, and rethrows without one", async (finish, reject, landed) => {
    const store = new ScriptedStore();
    const { idempotency, database } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    let committed: IdempotentResponse | undefined;
    store.rules.push({
      match: (expectedVersion) => expectedVersion === holder.version,
      before: async () => {
        if (landed === "no receipt") return;
        if (landed === "the holder's own commit") committed = await database.createOrder(holder, "book");
        else {
          const fingerprint = landed === "the same body" ? holder.fingerprint : "test-other-body-fingerprint";
          database.receiptsByKey.set(holder.storeKey, { ...holder, fingerprint, claimId: "test-claim-earlier", response: earlier });
        }
      },
      reject,
    });
    const run = finish === "settle" ? idempotency.settle(holder, { status: 503, body: "fallback" }) : idempotency.release(holder);
    if (landed === "no receipt") return void (await expect(run).rejects.toThrow("store write failed"));
    if (landed === "the holder's own commit") {
      expect(await run).toEqual({ outcome: finish === "settle" ? "settled" : "committed", response: committed });
    } else {
      expect(await run).toEqual(landed === "the same body" ? { outcome: "committed", response: earlier } : { outcome: "conflict" });
    }
    // A fallback the rejected write applied was replaced over its exact version: after a prune it never replays.
    database.receiptsByKey.clear();
    const later = await idempotency.claim(orderRequest());
    expect(later.outcome === "replay" ? later.response.status : undefined).not.toBe(503);
    if (finish === "settle" && reject === "applied" && landed === "the holder's own commit") {
      expect(later).toEqual({ outcome: "replay", response: committed, source: "store" });
    }
  });

  it("R2: a replacement that lost to a newer epoch decides from the receipt read now, and throws when that read fails", async () => {
    const store = new EpochDuringCleanupStore();
    const database = new FakeOrderDatabase();
    const source = switchableReceipts(database);
    const clock = new FakeClock();
    const { idempotency } = setup({ store, receipts: source.receipts, clock });
    const holder = acquired(await idempotency.claim(orderRequest()));
    // A late commit A of another body lands during the fallback write.
    store.onComplete = (storeKey) =>
      database.receiptsByKey.set(storeKey, { ...holder, fingerprint: "test-other-body-fingerprint", claimId: "test-claim-a", response: earlier });
    let newer: IdempotencyToken | undefined;
    store.onCleanup = async () => {
      // Before the retire write: retention ends, A is pruned, the record is evicted, B claims and commits, and the source fails.
      clock.advance(60_001);
      database.receiptsByKey.clear();
      store.records.clear();
      newer = acquired(await idempotency.claim(orderRequest({ body: otherBody })));
      await database.createOrder(newer, "newer");
      source.state.mode = "outage";
    };
    await expect(idempotency.settle(holder, { status: 503, body: "fallback" })).rejects.toThrow("receipt source unavailable");
    expect(store.records.get(holder.storeKey)).toMatchObject({ state: "pending", version: newer!.version });
  });

  it("R2: a rejected replacement whose fallback still holds the key fails closed (round 7)", async () => {
    const store = new ScriptedStore();
    const { idempotency, database } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    store.rules.push(
      {
        // A late commit A of another body lands during the fallback write.
        match: (expectedVersion) => expectedVersion === holder.version,
        before: () => database.receiptsByKey.set(holder.storeKey, { ...holder, fingerprint: "test-other-body-fingerprint", claimId: "test-claim-a", response: earlier }),
      },
      {
        // Before the replacement is rejected unapplied, A is pruned and commit B of the same body lands.
        match: (expectedVersion) => expectedVersion !== null && expectedVersion !== holder.version,
        before: () => database.receiptsByKey.set(holder.storeKey, { ...holder, claimId: "test-claim-b", response: earlier }),
        reject: "not applied",
      },
    );
    await expect(idempotency.settle(holder, { status: 503, body: "fallback" })).rejects.toThrow("store write failed");
  });

  it("R4: a rejected settle write whose version cannot be read still replaces an applied fallback over its exact version", async () => {
    class FlakyReadStore extends ScriptedStore {
      failReads = 0;
      override async get(storeKey: string) {
        if (this.failReads > 0) {
          this.failReads -= 1;
          throw new Error("store read failed");
        }
        return super.get(storeKey);
      }
    }
    const store = new FlakyReadStore();
    const { idempotency, database } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    let committed: IdempotentResponse | undefined;
    store.rules.push({
      match: (expectedVersion) => expectedVersion === holder.version,
      before: async () => {
        committed = await database.createOrder(holder, "book");
        store.failReads = 1;
      },
      reject: "applied",
    });
    expect(await idempotency.settle(holder, { status: 503, body: "fallback" })).toEqual({ outcome: "settled", response: committed });
    database.receiptsByKey.clear();
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "store" });
  });

  it("R4: a rejected settle write the store shows unapplied decides from the validated receipt with no replacement", async () => {
    const store = new ScriptedStore();
    const database = new FakeOrderDatabase();
    let lookups = 0;
    const receipts: IdempotencyReceiptSource = {
      find: async (storeKey) => {
        lookups += 1;
        // claim reads twice, and settle before and after its rejected write: any further read fails.
        if (lookups > 4) throw new Error("receipt source unavailable");
        return database.receipts.find(storeKey);
      },
    };
    const { idempotency } = setup({ store, receipts });
    const holder = acquired(await idempotency.claim(orderRequest()));
    let committed: IdempotentResponse | undefined;
    store.rules.push({
      match: (expectedVersion) => expectedVersion === holder.version,
      before: async () => {
        committed = await database.createOrder(holder, "book");
      },
      reject: "not applied",
    });
    expect(await idempotency.settle(holder, { status: 503, body: "fallback" })).toEqual({ outcome: "settled", response: committed });
    expect(lookups).toBe(4);
    expect(store.records.get(holder.storeKey)).toMatchObject({ state: "pending", version: holder.version });
  });

  it("R5: a completed record without the flag never replays during an outage, and a non-boolean flag fails closed", async () => {
    const { idempotency, database, source, store } = world(new FakeAtomicStore());
    const holder = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(holder, "book");
    await idempotency.settle(holder, committed);
    const flagged = store.records.get(holder.storeKey)!;
    expect(flagged).toMatchObject({ state: "completed", receiptSettled: true });

    const { receiptSettled: _flag, ...legacy } = flagged as IdempotencyRecord & { receiptSettled?: boolean };
    for (const record of [legacy, { ...flagged, receiptSettled: false }]) {
      store.records.set(holder.storeKey, record as IdempotencyRecord);
      source.state.mode = "outage";
      await expect(idempotency.claim(orderRequest())).rejects.toThrow("receipt source unavailable");
      await expect(idempotency.recover(orderRequest())).rejects.toThrow("receipt source unavailable");
      source.state.mode = "ok";
      expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    }
    for (const value of ["true", 1, null, {}]) {
      store.records.set(holder.storeKey, { ...flagged, receiptSettled: value } as unknown as IdempotencyRecord);
      await expect(idempotency.claim(orderRequest())).rejects.toThrow("malformed record");
      await expect(idempotency.recover(orderRequest())).rejects.toThrow("malformed record");
    }
  });

  it.each(["claim", "recover"] as const)(
    "(d) %s decides at its single receipt read: a receipt the source returned was the commit when it answered, and nothing is written",
    async (operation) => {
      const database = new FakeOrderDatabase();
      let pause: (() => Promise<void>) | undefined;
      const receipts: IdempotencyReceiptSource = {
        find: async (storeKey) => {
          const found = await database.receipts.find(storeKey);
          const run = pause;
          pause = undefined;
          await run?.(); // the answer is captured; the caller sees it only after the run
          return found;
        },
      };
      const store = new SpyStore();
      const idempotency = createRequestIdempotency({ store, receipts, clock: new FakeClock(), leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
      const first = acquired(await idempotency.claim(orderRequest()));
      const firstResponse = await database.createOrder(first, "book");
      let newerRecord: IdempotencyRecord | undefined;
      let writes = 0;
      pause = async () => {
        // After A was read: A is pruned, the record evicted, and B commits another body and settles.
        database.receiptsByKey.clear();
        store.records.clear();
        const newer = acquired(await idempotency.claim(orderRequest({ body: otherBody })));
        await idempotency.settle(newer, await database.createOrder(newer, "pen"));
        newerRecord = structuredClone(store.records.get(newer.storeKey));
        writes = store.log.length;
      };
      expect(await idempotency[operation](orderRequest())).toEqual({ outcome: "replay", response: firstResponse, source: "receipt" });
      expect(store.log.length).toBe(writes);
      expect(store.records.get(first.storeKey)).toEqual(newerRecord);
      // The next read sees B: A's body conflicts.
      expect(await idempotency[operation](orderRequest())).toEqual({ outcome: "conflict" });
    },
  );
});

describe("createRequestIdempotency PR round-7 live-version fence", () => {
  const earlier = { status: 201, headers: { "content-type": "text/plain" }, body: "earlier commit" };

  /** A receipt source that keeps each receipt for `retainMs` after it lands, like a host's retention job. */
  function world(store: FakeAtomicStore, retainMs = Number.POSITIVE_INFINITY) {
    const database = new FakeOrderDatabase();
    const clock = new FakeClock();
    const landed = new Map<string, number>();
    const state = { mode: "ok" as "ok" | "outage" };
    const receipts: IdempotencyReceiptSource = {
      find: async (storeKey) => {
        if (state.mode === "outage") throw new Error("receipt source unavailable");
        const found = await database.receipts.find(storeKey);
        if (!found) return found;
        if (!landed.has(storeKey)) landed.set(storeKey, clock.now());
        return clock.now() - landed.get(storeKey)! < retainMs ? found : null;
      },
    };
    const options = { store, receipts, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce };
    return { store, database, clock, state, idempotency: createRequestIdempotency(options) };
  }

  it("a commit landing in settle's empty lookup with an unapplied replacement fails closed, and a retained receipt keeps the fallback from replaying", async () => {
    const store = new ScriptedStore();
    // The README requirement: the receipt outlives the actual deadline of any fallback it contradicts.
    const { idempotency, database, clock } = world(store, 120_000);
    const holder = acquired(await idempotency.claim(orderRequest()));
    clock.advance(30_000);
    let committed: IdempotentResponse | undefined;
    store.rules.push(
      { match: (expectedVersion) => expectedVersion === holder.version, before: async () => void (committed = await database.createOrder(holder, "book")) },
      { match: (expectedVersion) => expectedVersion !== null && expectedVersion !== holder.version, reject: "not applied" },
    );
    await expect(idempotency.settle(holder, { status: 503, body: "fallback" })).rejects.toThrow("store write failed");
    expect(store.records.get(holder.storeKey)).toMatchObject({ state: "completed", response: { status: 503 } });

    // Past the commit's first retentionMs but before the fallback's deadline (settle + retentionMs): the receipt decides.
    clock.advance(59_000);
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    // Once the fallback has expired, no 503 is ever replayed.
    clock.advance(2_000);
    const later = await idempotency.recover(orderRequest());
    expect(later.outcome === "replay" ? later.response.status : undefined).not.toBe(503);
  });

  it.each([
    ["released", "empty"],
    ["released", "rejecting"],
    ["expired", "empty"],
    ["expired", "rejecting"],
  ] as const)("a rejected replacement over a fallback version that was %s, the lookup %s, is stale or throws, never the earlier receipt", async (gone, lookup) => {
    const store = new ScriptedStore();
    const { idempotency, database, clock, state } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    store.rules.push(
      {
        match: (expectedVersion) => expectedVersion === holder.version,
        before: () => void database.receiptsByKey.set(holder.storeKey, { ...holder, fingerprint: "test-other-body-fingerprint", claimId: "test-claim-a", response: earlier }),
      },
      {
        match: (expectedVersion) => expectedVersion !== null && expectedVersion !== holder.version,
        before: () => {
          // The fallback stops being live before the replacement is rejected unapplied, and the receipt is gone.
          const record = store.records.get(holder.storeKey)!;
          const { version, generation, fingerprint, recovery, expiresAt } = record;
          if (gone === "released") store.records.set(holder.storeKey, { state: "released", version, generation, fingerprint, recovery, expiresAt });
          else clock.advance(60_001);
          database.receiptsByKey.clear();
          if (lookup === "rejecting") state.mode = "outage";
        },
        reject: "not applied",
      },
    );
    const run = idempotency.settle(holder, { status: 503, body: "fallback" });
    if (lookup === "empty") expect(await run).toEqual({ outcome: "stale" });
    else await expect(run).rejects.toThrow("receipt source unavailable");
  });

  it("a rejected first write whose attempted version has expired is stale once the receipt is gone", async () => {
    const store = new ScriptedStore();
    const { idempotency, database, clock } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    await database.createOrder(holder, "book");
    store.rules.push({
      match: (expectedVersion) => expectedVersion === holder.version,
      before: () => {
        // The applied write's record expires and the receipt is pruned before the store is read.
        clock.advance(60_001);
        database.receiptsByKey.clear();
      },
      reject: "applied",
    });
    expect(await idempotency.settle(holder, { status: 201, body: "book" })).toEqual({ outcome: "stale" });
  });

  it("a fallback that expires while the store read is in flight decides from the receipt, never by the pre-read clock", async () => {
    class SlowReadStore extends ScriptedStore {
      onGet: (() => void) | undefined;
      override async get(storeKey: string) {
        const record = await super.get(storeKey);
        const run = this.onGet;
        this.onGet = undefined;
        run?.(); // the read completes at the fallback's exact deadline
        return record;
      }
    }
    const store = new SlowReadStore();
    const { idempotency, database, clock } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    store.rules.push(
      {
        match: (expectedVersion) => expectedVersion === holder.version,
        before: () => void database.receiptsByKey.set(holder.storeKey, { ...holder, claimId: "test-claim-a", response: earlier }),
      },
      {
        match: (expectedVersion) => expectedVersion !== null && expectedVersion !== holder.version,
        before: () => void (store.onGet = () => clock.advance(60_000)),
        reject: "not applied",
      },
    );
    expect(await idempotency.settle(holder, { status: 503, body: "fallback" })).toEqual({ outcome: "committed", response: earlier });
  });

  it.each(["the holder's own late commit", "an earlier commit of another body"] as const)(
    "an applied replacement over %s that expired before the store read decides like a lost write",
    async (commit) => {
      const store = new ScriptedStore();
      const { idempotency, database, clock } = world(store);
      const holder = acquired(await idempotency.claim(orderRequest()));
      store.rules.push(
        {
          match: (expectedVersion) => expectedVersion === holder.version,
          before: async () => {
            if (commit === "the holder's own late commit") await database.createOrder(holder, "book");
            else database.receiptsByKey.set(holder.storeKey, { ...holder, fingerprint: "test-other-body-fingerprint", claimId: "test-claim-a", response: earlier });
          },
        },
        { match: (expectedVersion) => expectedVersion !== null && expectedVersion !== holder.version, reject: "applied" },
      );
      // The replacement applies but loses its acknowledgement; its deadline passes and the receipt is pruned before the store read.
      const failing = store.compareAndSet.bind(store);
      store.compareAndSet = async (storeKey, expectedVersion, next) => {
        try {
          return await failing(storeKey, expectedVersion, next);
        } catch (error) {
          if (expectedVersion !== holder.version) {
            clock.advance(60_001);
            database.receiptsByKey.clear();
          }
          throw error;
        }
      };
      expect(await idempotency.settle(holder, { status: 503, body: "fallback" })).toEqual({ outcome: "stale" });
    },
  );

  it.each(["claim", "recover"] as const)(
    "%s in flight across a contradicted fallback's deadline never replays it once the receipt lookup answers empty",
    async (operation) => {
      const store = new ScriptedStore();
      const database = new FakeOrderDatabase();
      const clock = new FakeClock();
      let duringLookup: (() => void) | undefined;
      const receipts: IdempotencyReceiptSource = {
        find: async (storeKey) => {
          const run = duringLookup;
          duringLookup = undefined;
          run?.(); // the lookup reads only after the fallback's deadline passed and the receipt was pruned
          return database.receipts.find(storeKey);
        },
      };
      const idempotency = createRequestIdempotency({ store, receipts, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
      const holder = acquired(await idempotency.claim(orderRequest()));
      store.rules.push(
        { match: (expectedVersion) => expectedVersion === holder.version, before: async () => void (await database.createOrder(holder, "book")) },
        { match: (expectedVersion) => expectedVersion !== null && expectedVersion !== holder.version, reject: "not applied" },
      );
      await expect(idempotency.settle(holder, { status: 503, body: "fallback" })).rejects.toThrow("store write failed");
      const fallback = store.records.get(holder.storeKey)!;
      expect(fallback).toMatchObject({ state: "completed", response: { status: 503 } });

      // The request reads the fallback just before its deadline; the receipt is retained until just after it.
      clock.time = fallback.expiresAt - 1;
      duringLookup = () => {
        clock.advance(2);
        database.receiptsByKey.clear();
      };
      const result = await idempotency[operation](orderRequest());
      expect(result.outcome).not.toBe("replay");
      expect(result.outcome).toBe(operation === "claim" ? "acquired" : "absent");
    },
  );

  it("an applied-then-rejected replacement still reports the receipt", async () => {
    const store = new ScriptedStore();
    const { idempotency, database } = world(store);
    const holder = acquired(await idempotency.claim(orderRequest()));
    store.rules.push(
      {
        match: (expectedVersion) => expectedVersion === holder.version,
        before: () => void database.receiptsByKey.set(holder.storeKey, { ...holder, claimId: "test-claim-a", response: earlier }),
      },
      { match: (expectedVersion) => expectedVersion !== null && expectedVersion !== holder.version, reject: "applied" },
    );
    expect(await idempotency.settle(holder, { status: 503, body: "fallback" })).toEqual({ outcome: "committed", response: earlier });
    expect(store.records.get(holder.storeKey)).toMatchObject({ state: "released" });
  });
});
