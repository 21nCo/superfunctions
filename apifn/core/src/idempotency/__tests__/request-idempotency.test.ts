import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  createRequestIdempotency,
  normalizeIdempotentResponse,
  sha256Fingerprint,
  type IdempotencyCommit,
  type IdempotencyDiagnostic,
  type IdempotencyReceipt,
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

    const retry = await idempotency.claim(orderRequest());
    expect(retry).toMatchObject({ outcome: "replay", source: "store", response: { status: 201 } });
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
    expect(await restarted.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "store" });
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
    const store = new FakeAtomicStore();
    const idempotency = createRequestIdempotency({ store });
    const token = acquired(await idempotency.claim(orderRequest({ recovery: "none" })));
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
      expect([...store.records.values()][0]).toEqual(recorded);
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
    // The stored copy is bounded, but a replay reads the full response from the receipt.
    expect([...store.records.values()][0]).toMatchObject({ fromReceipt: true, response: { omitted: ["body"] } });
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

    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt", response: { status: 201 } });
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "store", response: { status: 201 } });
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
    expect(normalizeIdempotentResponse({ status: 200, headers, body: "x".repeat(1_000) }, 400)).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      omitted: ["body"],
    });
    expect(normalizeIdempotentResponse({ status: 200, headers, body: "x" }).headers).not.toHaveProperty("transfer-encoding");
    expect(normalizeIdempotentResponse({ status: 204, headers: { "x-large": "y".repeat(100) } }, 50)).toEqual({
      status: 204,
      headers: {},
      omitted: ["headers"],
    });
  });

  it("drops headers too when they alone exceed the bound", () => {
    expect(normalizeIdempotentResponse({ status: 200, headers: { "x-large": "y".repeat(100) }, body: "z" }, 50)).toEqual({
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

  it("returns the holder's own response unchanged on its own commit and strips credentials from another holder's", async () => {
    const { idempotency, database, clock } = setup();
    const own = acquired(await idempotency.claim(orderRequest()));
    const committed = await database.createOrder(own, "book");
    const sent = { ...committed, headers: { ...committed.headers, "Set-Cookie": "session=test-session-value" } };
    expect(await idempotency.settle(own, sent)).toEqual({ outcome: "settled", response: sent });

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
      { ...base, recovery: "none", fromReceipt: true, response: { status: 200, headers: {} } },
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
