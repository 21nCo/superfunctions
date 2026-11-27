import { createHash, webcrypto } from "node:crypto";
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
  it("classifies from a validated receipt when every cache write loses, and never overwrites the newer record", async () => {
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

    // The newer writer's pending record stays exactly as it wrote it.
    const expectUntouched = (token: IdempotencyToken) => {
      expect(store.records.get(token.storeKey)).toEqual(store.newest.get(token.storeKey));
      expect(store.records.get(token.storeKey)).toMatchObject({ state: "pending", version: expect.stringMatching(/^test-version-newer-/) });
    };

    expect(await idempotency.settle(own, committed)).toEqual({ outcome: "settled", response: committed });
    expectUntouched(own);
    expect(await idempotency.settle(current, { status: 409 })).toEqual({ outcome: "committed", response: committed });
    expect(await idempotency.settle(loser, { status: 409 })).toEqual({ outcome: "conflict" });
    expect(await idempotency.release(own)).toEqual({ outcome: "committed", response: committed });
    expect(await idempotency.release(loser)).toEqual({ outcome: "conflict" });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.claim(conflictKey)).toEqual({ outcome: "conflict" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "replay", response: committed, source: "receipt" });
    expect(await idempotency.recover(conflictKey)).toEqual({ outcome: "conflict" });
    for (const token of [own, current, loser]) expectUntouched(token);
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
      expect(await idempotency.claim(request)).toEqual({ outcome: "replay", response: committed, source: "store" });
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
    expect([...store.records.values()][0]).toMatchObject({ state: "completed", fromReceipt: true, recovery: "receipt" });
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
    expect([...store.records.values()][0]).toMatchObject({ state: "completed", fromReceipt: true, generation: 2 });
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
  it("never lets a stale holder's receipt replace a newer claim after the key's retention ended", async () => {
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

    expect(await idempotency.settle(stale, response)).toEqual({ outcome: "stale" });
    expect(newer).toBeDefined();
    expect(store.records.get(stale.storeKey)).toEqual(newerRecord);

    const newerResponse = await database.createOrder(newer!, "book");
    expect(await idempotency.settle(newer!, newerResponse)).toEqual({ outcome: "settled", response: newerResponse });
    expect(store.records.get(stale.storeKey)).toMatchObject({ fromReceipt: true, receiptClaimId: newer!.claimId });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: newerResponse, source: "store" });
  });

  it("records a newer commit over a record recorded from an older receipt for the same body", async () => {
    const { idempotency, database, store } = setup();
    const first = acquired(await idempotency.claim(orderRequest()));
    await idempotency.settle(first, await database.createOrder(first, "book"));
    expect(store.records.get(first.storeKey)).toMatchObject({ fromReceipt: true, receiptClaimId: first.claimId });
    // The receipt store purged the first commit and a later claim of the same body committed again.
    database.receiptsByKey.clear();
    const later = { ...first, version: "test-version-later", claimId: "test-claim-later" };
    const laterResponse = await database.createOrder(later, "book again");

    expect(await idempotency.settle(later, laterResponse)).toEqual({ outcome: "settled", response: laterResponse });
    expect(store.records.get(first.storeKey)).toMatchObject({ receiptClaimId: "test-claim-later", response: { body: laterResponse.body } });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response: laterResponse, source: "store" });
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

describe("createRequestIdempotency PR round-1 regressions", () => {
  const otherBody = { item: "pen", quantity: 2 };

  /** Inside a paused lookup: receipt A expires, a newer claim of another body commits and settles, and its record is evicted. */
  function newerEpoch(
    idempotency: ReturnType<typeof createRequestIdempotency>,
    database: FakeOrderDatabase,
    store: FakeAtomicStore,
    evict = true,
  ) {
    const newer: { response?: IdempotentResponse; claimId?: string } = {};
    const run = async () => {
      database.receiptsByKey.clear();
      const token = acquired(await idempotency.claim(orderRequest({ body: otherBody })));
      newer.claimId = token.claimId;
      newer.response = await database.createOrder(token, "pen");
      await idempotency.settle(token, newer.response);
      if (evict) store.records.clear();
    };
    return { newer, run };
  }

  async function expectNewerWins(
    idempotency: ReturnType<typeof createRequestIdempotency>,
    store: FakeAtomicStore,
    newer: { response?: IdempotentResponse; claimId?: string },
  ) {
    expect([...store.records.values()][0]).toMatchObject({ state: "completed", fromReceipt: true, receiptClaimId: newer.claimId });
    expect(await idempotency.claim(orderRequest({ body: otherBody }))).toMatchObject({ outcome: "replay", response: newer.response });
    expect(await idempotency.recover(orderRequest({ body: otherBody }))).toMatchObject({ outcome: "replay", response: newer.response });
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "conflict" });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "conflict" });
  }

  it("never caches a receipt read over an evicted key once a newer claim committed and was evicted", async () => {
    const database = new FakeOrderDatabase();
    const store = new FakeAtomicStore();
    const paused = pausingReceipts(database);
    const { idempotency } = setup({ store, receipts: paused.receipts });
    const first = acquired(await idempotency.claim(orderRequest()));
    await idempotency.settle(first, await database.createOrder(first, "book"));
    store.records.clear();
    const { newer, run } = newerEpoch(idempotency, database, store);
    paused.pauseNext(run);

    // The paused lookup returns receipt A after receipt B committed: B decides, never A.
    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "conflict" });
    await expectNewerWins(idempotency, store, newer);
  });

  it.each(["settle", "release"] as const)("never leaves an older receipt cached over a newer commit on %s", async (action) => {
    const database = new FakeOrderDatabase();
    const store = new FakeAtomicStore();
    const paused = pausingReceipts(database);
    const { idempotency } = setup({ store, receipts: paused.receipts });
    const holder = acquired(await idempotency.claim(orderRequest()));
    const response = await database.createOrder(holder, "book");
    store.records.clear();
    const { newer, run } = newerEpoch(idempotency, database, store);
    paused.pauseNext(run);

    const result = action === "settle" ? await idempotency.settle(holder, response) : await idempotency.release(holder);
    expect(result).toEqual({ outcome: "conflict" });
    await expectNewerWins(idempotency, store, newer);
  });

  it("replays a newer durable receipt over a record cached from an older one", async () => {
    const { idempotency, database, store, clock } = setup();
    const first = acquired(await idempotency.claim(orderRequest()));
    await idempotency.settle(first, await database.createOrder(first, "book"));
    // A copy cached from receipt A survives (its writer stopped before any recheck) while receipt B commits.
    database.receiptsByKey.clear();
    const other = createRequestIdempotency({ store: new FakeAtomicStore(), receipts: database.receipts, clock, nonce: testNonce });
    const later = acquired(await other.claim(orderRequest({ body: otherBody })));
    const laterResponse = await database.createOrder(later, "pen");
    expect([...store.records.values()][0]).toMatchObject({ receiptClaimId: first.claimId });

    // The first read records receipt B over the cached copy and replays it from the receipt.
    expect(await idempotency.claim(orderRequest({ body: otherBody }))).toEqual({ outcome: "replay", response: laterResponse, source: "receipt" });
    expect([...store.records.values()][0]).toMatchObject({ receiptClaimId: later.claimId });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "conflict" });
  });

  /** A first commit (receipt A) whose record was evicted while its receipt is retained. */
  async function evictedFirstCommit(store: FakeAtomicStore, wrap?: (database: FakeOrderDatabase) => IdempotencyReceiptSource) {
    const database = new FakeOrderDatabase();
    const paused = pausingReceipts(database);
    const { idempotency } = setup({ store, receipts: wrap ? wrap(database) : paused.receipts });
    const first = acquired(await idempotency.claim(orderRequest()));
    await idempotency.settle(first, await database.createOrder(first, "book"));
    store.records.clear();
    return { database, paused, idempotency };
  }

  it("retires a copy written over an absence when the receipt expired meanwhile, so the key can be reused", async () => {
    const store = new FakeAtomicStore();
    const { database, paused, idempotency } = await evictedFirstCommit(store);
    paused.pauseNext(async () => database.receiptsByKey.clear());

    const result = await idempotency.claim(orderRequest());
    expect(result.outcome).toBe("acquired");
    expect([...store.records.values()]).toEqual([expect.objectContaining({ state: "pending" })]);
  });

  it("lets the newer commit decide when the write over an absence loses its acknowledgement", async () => {
    class LostAckReceiptStore extends FakeAtomicStore {
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        const written = await super.compareAndSet(storeKey, expectedVersion, next);
        if (expectedVersion === null && next?.state === "completed" && next.receiptClaimId === "test-claim-a") {
          throw new Error("store acknowledgement lost");
        }
        return written;
      }
    }
    const store = new LostAckReceiptStore();
    const { database, paused, idempotency } = await evictedFirstCommit(store);
    const [key, receiptA] = [...database.receiptsByKey.entries()][0]!;
    database.receiptsByKey.set(key, { ...receiptA, claimId: "test-claim-a" });
    const { newer, run } = newerEpoch(idempotency, database, store);
    paused.pauseNext(run);

    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "conflict" });
    await expectNewerWins(idempotency, store, newer);
  });

  it("lets the newer commit decide when a write over an absence loses to the newer record", async () => {
    const store = new FakeAtomicStore();
    const { database, paused, idempotency } = await evictedFirstCommit(store);
    const { newer, run } = newerEpoch(idempotency, database, store, false);
    paused.pauseNext(run);

    expect(await idempotency.claim(orderRequest({ body: otherBody }))).toMatchObject({ outcome: "replay", response: newer.response });
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "conflict" });
    expect([...store.records.values()][0]).toMatchObject({ receiptClaimId: newer.claimId });
  });

  it("fails closed and retires its copy when the receipt cannot be read again after a write over an absence", async () => {
    const store = new FakeAtomicStore();
    let finds: number | undefined;
    const { idempotency } = await evictedFirstCommit(store, (database) => ({
      find: async (storeKey: string) => {
        if (finds !== undefined && (finds += 1) === 2) throw new Error("receipt lookup failed");
        return database.receipts.find(storeKey);
      },
    }));
    // Lookup 1 is the claim's read over the evicted key; lookup 2 is the re-read after its write over that absence.
    finds = 0;
    await expect(idempotency.claim(orderRequest())).rejects.toThrow("receipt lookup failed");
    expect([...store.records.values()]).toEqual([expect.objectContaining({ state: "released", recovery: "receipt" })]);
  });

  it("keeps replaying a confirmed copy after the host prunes its receipt, until the copy's own retention ends", async () => {
    const { idempotency, database, clock } = setup();
    const first = acquired(await idempotency.claim(orderRequest()));
    const response = await database.createOrder(first, "book");
    await idempotency.settle(first, response);
    clock.advance(30_000);
    database.receiptsByKey.clear();

    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response, source: "store" });
    expect(await idempotency.recover(orderRequest({ body: otherBody }))).toEqual({ outcome: "conflict" });
    clock.advance(30_000);
    expect((await idempotency.claim(orderRequest())).outcome).toBe("acquired");
  });

  it("settles from a newer receipt the recheck validated when the write over an absence lost to its record", async () => {
    const database = new FakeOrderDatabase();
    const paused = pausingReceipts(database);
    let finds: number | undefined;
    const receipts = {
      find: async (storeKey: string) => {
        if (finds !== undefined && (finds += 1) > 2) throw new Error("receipt lookup failed");
        return paused.receipts.find(storeKey);
      },
    };
    const store = new FakeAtomicStore();
    const { idempotency } = setup({ store, receipts });
    const holder = acquired(await idempotency.claim(orderRequest()));
    const response = await database.createOrder(holder, "book");
    store.records.clear();
    const { newer, run } = newerEpoch(idempotency, database, store, false);
    paused.pauseNext(async () => {
      const saved = finds;
      finds = undefined;
      await run();
      finds = saved;
    });
    finds = 0;

    expect(await idempotency.release(holder)).toEqual({ outcome: "conflict" });
    expect([...store.records.values()][0]).toMatchObject({ receiptClaimId: newer.claimId });
  });

  it("replays a complete confirmed copy from the store while the receipt source is down", async () => {
    const database = new FakeOrderDatabase();
    let down = false;
    const receipts = {
      find: async (storeKey: string) => {
        if (down) throw new Error("receipt source unavailable");
        return database.receipts.find(storeKey);
      },
    };
    const { idempotency } = setup({ receipts });
    const first = acquired(await idempotency.claim(orderRequest()));
    const response = await database.createOrder(first, "book");
    await idempotency.settle(first, response);
    down = true;

    expect(await idempotency.claim(orderRequest())).toEqual({ outcome: "replay", response, source: "store" });
    expect(await idempotency.recover(orderRequest({ body: otherBody }))).toEqual({ outcome: "conflict" });
  });

  it("lets a newer receipt the recheck validated decide when the write over an absence lost its acknowledgement", async () => {
    class RejectingCopyStore extends FakeAtomicStore {
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        if (expectedVersion === null && next?.state === "completed" && next.receiptClaimId === "test-claim-a") {
          throw new Error("store write failed");
        }
        return super.compareAndSet(storeKey, expectedVersion, next);
      }
    }
    const store = new RejectingCopyStore();
    const database = new FakeOrderDatabase();
    const paused = pausingReceipts(database);
    let finds: number | undefined;
    const receipts = {
      find: async (storeKey: string) => {
        // After the paused read and the recheck, any further lookup fails: B must already decide.
        if (finds !== undefined && (finds += 1) > 2) throw new Error("receipt lookup failed");
        return paused.receipts.find(storeKey);
      },
    };
    const { idempotency } = setup({ store, receipts });
    const holder = { ...acquired(await idempotency.claim(orderRequest())), claimId: "test-claim-a" };
    const response = await database.createOrder(holder, "book");
    store.records.clear();
    const { newer, run } = newerEpoch(idempotency, database, store);
    paused.pauseNext(async () => {
      const saved = finds;
      finds = undefined;
      await run();
      finds = saved;
    });
    finds = 0;

    expect(await idempotency.settle(holder, response)).toEqual({ outcome: "conflict" });
    expect(newer.claimId).toBeDefined();
  });

  it("settles from a receipt the recheck confirms after the write over an absence lost its acknowledgement", async () => {
    class RejectingCopyStore extends FakeAtomicStore {
      override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null) {
        if (expectedVersion === null && next?.state === "completed") throw new Error("store write failed");
        return super.compareAndSet(storeKey, expectedVersion, next);
      }
    }
    const store = new RejectingCopyStore();
    let finds: number | undefined;
    const database = new FakeOrderDatabase();
    const receipts = {
      find: async (storeKey: string) => {
        if (finds !== undefined && (finds += 1) === 3) throw new Error("receipt lookup failed");
        return database.receipts.find(storeKey);
      },
    };
    const { idempotency } = setup({ store, receipts });
    const holder = acquired(await idempotency.claim(orderRequest()));
    const response = await database.createOrder(holder, "book");
    store.records.clear();
    finds = 0;

    expect(await idempotency.settle(holder, response)).toMatchObject({ outcome: "settled", response: { body: response.body } });
  });
});

/** Atomic store with hooks around a write over an absence, and an optional failing tombstone write. */
class AbsenceHookStore extends FakeAtomicStore {
  beforeAbsenceWrite?: () => Promise<void>;
  afterAbsenceWrite?: () => Promise<void>;
  failTombstones = false;

  override async compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean> {
    const before = expectedVersion === null ? this.beforeAbsenceWrite : undefined;
    if (before) {
      this.beforeAbsenceWrite = undefined;
      await before();
    }
    if (this.failTombstones && next?.state === "released") throw new Error("store write failed");
    const written = await super.compareAndSet(storeKey, expectedVersion, next);
    const after = written && expectedVersion === null ? this.afterAbsenceWrite : undefined;
    if (after) {
      this.afterAbsenceWrite = undefined;
      await after();
    }
    return written;
  }
}

/** A receipt source that can be made to reject, to answer with an invalid receipt, or to reject after `failAfter` lookups. */
function switchableReceipts(database: FakeOrderDatabase) {
  const state: { mode: "ok" | "outage" | "status" | "storeKey"; failAfter?: number } = { mode: "ok" };
  const receipts: IdempotencyReceiptSource = {
    find: async (storeKey: string) => {
      const found = await database.receipts.find(storeKey);
      if (state.failAfter !== undefined && (state.failAfter -= 1) < 0) throw new Error("receipt source unavailable");
      if (state.mode === "outage") throw new Error("receipt source unavailable");
      if (found && state.mode === "status") return { ...found, response: { ...found.response, status: 99 } };
      if (found && state.mode === "storeKey") return { ...found, storeKey: "another-store-key" };
      return found;
    },
  };
  return { state, receipts };
}

describe("createRequestIdempotency PR round-2 regressions", () => {
  function world() {
    const store = new AbsenceHookStore();
    const database = new FakeOrderDatabase();
    const source = switchableReceipts(database);
    const clock = new FakeClock();
    const make = () =>
      createRequestIdempotency({ store, receipts: source.receipts, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
    return { store, database, source, clock, make };
  }

  /** Commits receipt A for the order key, then evicts its record. */
  async function committedAndEvicted(w: ReturnType<typeof world>) {
    const token = acquired(await w.make().claim(orderRequest()));
    const response = await w.database.createOrder(token, "book");
    w.store.records.clear();
    return { token, response };
  }

  it.each(["status", "storeKey"] as const)("fails closed on a receipt with an invalid %s over a confirmed copy", async (mode) => {
    const w = world();
    const idempotency = w.make();
    const token = acquired(await idempotency.claim(orderRequest()));
    await w.database.createOrder(token, "book");
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    w.source.state.mode = mode;
    await expect(idempotency.claim(orderRequest())).rejects.toThrow(/receipt/);
    await expect(idempotency.recover(orderRequest())).rejects.toThrow(/receipt/);
    // Only a source outage falls back to the confirmed complete copy.
    w.source.state.mode = "outage";
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "store" });
    expect(await idempotency.recover(orderRequest())).toMatchObject({ outcome: "replay", source: "store" });
  });

  it.each(["pruned", "outage"] as const)("never lets a concurrent reader decide from an unconfirmed absence copy (%s receipt)", async (kind) => {
    const w = world();
    await committedAndEvicted(w);
    const x = w.make();
    const y = w.make();
    const seen: unknown[] = [];
    w.store.afterAbsenceWrite = async () => {
      // Between X's write over the absence and X's recheck.
      expect([...w.store.records.values()][0]).toMatchObject({ fromReceipt: true, provisional: true });
      if (kind === "pruned") w.database.receiptsByKey.clear();
      else w.source.state.mode = "outage";
      for (const step of [() => y.recover(orderRequest()), () => y.claim(orderRequest())]) {
        seen.push(await step().catch((error: Error) => error.message));
      }
      w.source.state.mode = "ok";
    };
    const result = await x.claim(orderRequest());
    if (kind === "pruned") {
      expect(seen).toEqual([{ outcome: "absent" }, expect.objectContaining({ outcome: "acquired" })]);
      expect(result).toMatchObject({ outcome: "in_progress" });
    } else {
      expect(seen).toEqual(["receipt source unavailable", "receipt source unavailable"]);
      expect(result).toMatchObject({ outcome: "replay", source: "receipt" });
      expect([...w.store.records.values()][0]).not.toHaveProperty("provisional");
    }
  });

  it("never replays a provisional copy left by a failed retire", async () => {
    const w = world();
    await committedAndEvicted(w);
    const idempotency = w.make();
    w.store.afterAbsenceWrite = async () => {
      w.database.receiptsByKey.clear();
      w.store.failTombstones = true;
    };
    expect(await idempotency.recover(orderRequest())).toEqual({ outcome: "absent" });
    expect([...w.store.records.values()][0]).toMatchObject({ state: "completed", provisional: true });
    w.store.failTombstones = false;
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "acquired" });
  });

  it.each(["settle", "release"] as const)("%s decides with the validated receipt when its absence write loses to the same commit", async (action) => {
    const w = world();
    const { token, response } = await committedAndEvicted(w);
    const holder = w.make();
    const other = w.make();
    w.store.beforeAbsenceWrite = async () => {
      // Another instance records the same receipt first; only the recheck lookup succeeds after that.
      expect(await other.recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
      w.source.state.failAfter = 1;
    };
    if (action === "settle") {
      expect(await holder.settle(token, response)).toMatchObject({ outcome: "settled", response: { body: response.body } });
    } else {
      expect(await holder.release(token)).toMatchObject({ outcome: "committed", response: { body: response.body } });
    }
  });

  it("confirms an absence copy once the recheck validates it, and keeps the confirmed-copy fallbacks", async () => {
    const w = world();
    const { response } = await committedAndEvicted(w);
    const idempotency = w.make();
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    const [record] = [...w.store.records.values()];
    expect(record).toMatchObject({ state: "completed", fromReceipt: true });
    expect(record).not.toHaveProperty("provisional");
    w.source.state.mode = "outage";
    expect(await idempotency.recover(orderRequest())).toMatchObject({ outcome: "replay", source: "store", response: { body: response.body } });
    w.source.state.mode = "ok";
    w.database.receiptsByKey.clear();
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "replay", source: "store", response: { body: response.body } });
    w.clock.advance(60_000);
    expect(await idempotency.claim(orderRequest())).toMatchObject({ outcome: "acquired" });
  });

  it.each([
    ["on a record not recorded from a receipt", { provisional: true }],
    ["when it is not true", { fromReceipt: true, receiptClaimId: "test-claim", provisional: false }],
  ])("fails closed on a provisional flag %s", async (_name, extra) => {
    const { store, clock, idempotency } = setup();
    const token = acquired(await idempotency.claim(orderRequest()));
    store.records.set(token.storeKey, {
      state: "completed",
      version: "test-stored-version",
      generation: 1,
      fingerprint: token.fingerprint,
      recovery: "receipt",
      expiresAt: clock.time + 1_000,
      response: { status: 200, headers: {} },
      ...extra,
    } as IdempotencyRecord);
    await expect(idempotency.claim(orderRequest())).rejects.toThrow(/malformed record/);
  });
});

describe("createRequestIdempotency PR round-2 delta regressions", () => {
  function world() {
    const store = new HookedStore();
    const database = new FakeOrderDatabase();
    const source = switchableReceipts(database);
    const clock = new FakeClock();
    const make = () =>
      createRequestIdempotency({ store, receipts: source.receipts, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
    return { store, database, source, clock, make };
  }

  it.each([
    ["settle", "the same body"],
    ["settle", "another body"],
    ["release", "the same body"],
    ["release", "another body"],
  ] as const)("%s never decides with a receipt whose cache write lost to a newer commit (%s, source down)", async (action, bodyCase) => {
    const w = world();
    const holder = w.make();
    const token = acquired(await holder.claim(orderRequest()));
    const response = await w.database.createOrder(token, "book");
    const newer = bodyCase === "the same body" ? orderRequest() : orderRequest({ body: { item: "pen", quantity: 2 } });
    let newerResponse: IdempotentResponse | undefined;
    w.store.arm(token.version, async () => {
      // The holder's record and receipt end their retention; a newer claim takes the key, commits and settles.
      w.clock.advance(120_000);
      w.store.records.clear();
      w.database.receiptsByKey.clear();
      const other = w.make();
      const newerToken = acquired(await other.claim(newer));
      newerResponse = await w.database.createOrder(newerToken, "pen");
      expect(await other.settle(newerToken, newerResponse)).toMatchObject({ outcome: "settled" });
      w.source.state.mode = "outage";
    });
    const result = action === "settle" ? holder.settle(token, response) : holder.release(token);
    await expect(result).rejects.toThrow(/receipt source unavailable/);
    w.source.state.mode = "ok";
    // The newer commit keeps the key.
    expect(await w.make().recover(newer)).toMatchObject({ outcome: "replay", response: { body: newerResponse?.body } });
  });

  it.each(["settle", "release"] as const)("%s decides with its receipt during an outage when a confirmed copy of it won the write", async (action) => {
    const w = world();
    const holder = w.make();
    const token = acquired(await holder.claim(orderRequest()));
    const response = await w.database.createOrder(token, "book");
    w.store.arm(token.version, async () => {
      // Another instance records the same commit first, then the receipt source goes down.
      expect(await w.make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
      w.source.state.mode = "outage";
    });
    if (action === "settle") {
      expect(await holder.settle(token, response)).toMatchObject({ outcome: "settled", response: { body: response.body } });
    } else {
      expect(await holder.release(token)).toMatchObject({ outcome: "committed", response: { body: response.body } });
    }
  });

  it.each([
    ["recover", "pruned"],
    ["recover", "outage"],
    ["claim", "pruned"],
    ["claim", "outage"],
  ] as const)("%s decides from a copy another step confirmed while its lookup ran (%s receipt)", async (action, kind) => {
    const store = new FakeAtomicStore();
    const database = new FakeOrderDatabase();
    const clock = new FakeClock();
    let duringLookup: (() => Promise<void>) | undefined;
    let outage = false;
    const receipts: IdempotencyReceiptSource = {
      find: async (storeKey: string) => {
        const run = duringLookup;
        duringLookup = undefined;
        if (run) await run();
        if (outage) throw new Error("receipt source unavailable");
        return database.receipts.find(storeKey);
      },
    };
    const make = () => createRequestIdempotency({ store, receipts, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
    const token = acquired(await make().claim(orderRequest()));
    const response = await database.createOrder(token, "book");
    expect(await make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    const confirmed = store.records.get(token.storeKey);
    expect(confirmed).toMatchObject({ state: "completed", fromReceipt: true });
    expect(confirmed).not.toHaveProperty("provisional");
    const run = async (request: IdempotencyRequest) => {
      // The reader sees a provisional copy; while its lookup runs, the writer confirms it, then the receipt goes away.
      store.records.set(token.storeKey, { ...confirmed, version: "test-provisional-version", provisional: true } as IdempotencyRecord);
      duringLookup = async () => {
        store.records.set(token.storeKey, structuredClone(confirmed) as IdempotencyRecord);
        if (kind === "pruned") database.receiptsByKey.delete(token.storeKey);
        else outage = true;
      };
      return action === "recover" ? make().recover(request) : make().claim(request);
    };
    expect(await run(orderRequest())).toMatchObject({ outcome: "replay", source: "store", response: { body: response.body } });
    outage = false;
    database.receiptsByKey.set(token.storeKey, { ...token, response });
    expect(await run(orderRequest({ body: { item: "pen", quantity: 2 } }))).toMatchObject({ outcome: "conflict" });
  });
});

describe("createRequestIdempotency PR round-3 regressions", () => {
  function world<S extends FakeAtomicStore>(store: S) {
    const database = new FakeOrderDatabase();
    const clock = new FakeClock();
    const make = () =>
      createRequestIdempotency({ store, receipts: database.receipts, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
    return { store, database, clock, make };
  }

  /** Commits receipt A for the order key, then evicts its record. */
  async function committedAndEvicted(w: ReturnType<typeof world<AbsenceHookStore>>) {
    const token = acquired(await w.make().claim(orderRequest()));
    const response = await w.database.createOrder(token, "book");
    w.store.records.clear();
    return { token, response };
  }

  it.each(["settle", "release"] as const)("%s decides with its receipt when a concurrent step confirmed it and the host then pruned it", async (action) => {
    const w = world(new HookedStore());
    const holder = w.make();
    const token = acquired(await holder.claim(orderRequest()));
    const response = await w.database.createOrder(token, "book");
    w.store.arm(token.version, async () => {
      // While the holder's cache write is in flight, another instance confirms the same commit, then the receipt is pruned.
      expect(await w.make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
      w.database.receiptsByKey.clear();
    });
    if (action === "settle") {
      expect(await holder.settle(token, response)).toMatchObject({ outcome: "settled", response: { body: response.body } });
    } else {
      expect(await holder.release(token)).toMatchObject({ outcome: "committed", response: { body: response.body } });
    }
  });

  it("confirms the copy it replays even when the first confirming write fails, so a pruned receipt never frees the key early", async () => {
    const w = world(new AbsenceHookStore());
    const { response } = await committedAndEvicted(w);
    w.store.afterAbsenceWrite = async () => {
      vi.spyOn(w.store, "compareAndSet").mockRejectedValueOnce(new Error("store write failed"));
    };
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    vi.restoreAllMocks();
    expect([...w.store.records.values()][0]).not.toHaveProperty("provisional");
    w.database.receiptsByKey.clear();
    w.clock.advance(59_000);
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "replay", source: "store", response: { body: response.body } });
  });

  it("reports nothing from a copy it cannot confirm", async () => {
    const w = world(new AbsenceHookStore());
    await committedAndEvicted(w);
    w.store.afterAbsenceWrite = async () => {
      vi.spyOn(w.store, "compareAndSet").mockRejectedValue(new Error("store write failed"));
    };
    await expect(w.make().claim(orderRequest())).rejects.toThrow(/store write failed/);
    vi.restoreAllMocks();
    expect([...w.store.records.values()][0]).toMatchObject({ provisional: true });
    // The receipt is still there: the next step confirms the copy and replays it.
    expect(await w.make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    expect([...w.store.records.values()][0]).not.toHaveProperty("provisional");
  });

  it("keeps a provisional copy's deadline when a delayed recheck confirms it after that deadline", async () => {
    const w = world(new AbsenceHookStore());
    await committedAndEvicted(w);
    let deadline: number | undefined;
    w.store.afterAbsenceWrite = async () => {
      deadline = [...w.store.records.values()][0]?.expiresAt;
      w.clock.advance(60_001);
    };
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    const [record] = [...w.store.records.values()];
    expect(record).toMatchObject({ state: "completed", fromReceipt: true, expiresAt: deadline });
    expect(record).not.toHaveProperty("provisional");
    // The receipt is pruned: the expired copy leaves the key reusable.
    w.database.receiptsByKey.clear();
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "acquired" });
  });

  it("keeps a provisional copy's deadline when another step confirms it", async () => {
    const w = world(new FakeAtomicStore());
    const token = acquired(await w.make().claim(orderRequest()));
    const response = await w.database.createOrder(token, "book");
    expect(await w.make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    const deadline = w.clock.time + 5_000;
    const copy = { ...w.store.records.get(token.storeKey), version: "test-provisional-version", provisional: true, expiresAt: deadline };
    w.store.records.set(token.storeKey, copy as IdempotencyRecord);
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt", response: { body: response.body } });
    const confirmed = w.store.records.get(token.storeKey);
    expect(confirmed).toMatchObject({ expiresAt: deadline });
    expect(confirmed).not.toHaveProperty("provisional");
  });

  it.each([
    ["claim", "the same body"],
    ["claim", "another body"],
    ["recover", "the same body"],
    ["recover", "another body"],
  ] as const)("%s reports the newer commit when its write over a version loses to it (%s)", async (action, bodyCase) => {
    const w = world(new HookedStore());
    const token = acquired(await w.make().claim(orderRequest()));
    await w.database.createOrder(token, "book");
    const newer = bodyCase === "the same body" ? orderRequest() : orderRequest({ body: { item: "pen", quantity: 2 } });
    let newerResponse: IdempotentResponse | undefined;
    w.store.arm(token.version, async () => {
      // During the reader's cache write, the record and receipt end their retention; a newer claim commits and settles.
      w.clock.advance(120_000);
      w.store.records.clear();
      w.database.receiptsByKey.clear();
      const other = w.make();
      const newerToken = acquired(await other.claim(newer));
      newerResponse = await w.database.createOrder(newerToken, "pen");
      expect(await other.settle(newerToken, newerResponse)).toMatchObject({ outcome: "settled" });
    });
    const result = action === "claim" ? await w.make().claim(orderRequest()) : await w.make().recover(orderRequest());
    if (bodyCase === "the same body") {
      expect(result).toMatchObject({ outcome: "replay", source: "receipt", response: { body: newerResponse?.body } });
    } else {
      expect(result).toEqual({ outcome: "conflict" });
    }
  });
});

describe("createRequestIdempotency PR round-3 delta regressions", () => {
  function world<S extends FakeAtomicStore>(store: S, receipts?: IdempotencyReceiptSource) {
    const database = new FakeOrderDatabase();
    const clock = new FakeClock();
    const make = () =>
      createRequestIdempotency({ store, receipts: receipts ?? database.receipts, clock, leaseMs: 1_000, retentionMs: 60_000, nonce: testNonce });
    return { store, database, clock, make };
  }

  /** Runs `hook` inside the next compare-and-set, before it reaches the store. */
  function beforeNextWrite(store: FakeAtomicStore, hook: () => Promise<void>) {
    const original = store.compareAndSet.bind(store);
    vi.spyOn(store, "compareAndSet").mockImplementationOnce(async (...args) => {
      await hook();
      return original(...args);
    });
  }

  /** A provisional copy of the order key's committed receipt, as a crashed absence writer leaves it. */
  async function provisionalCopy(w: ReturnType<typeof world<AbsenceHookStore>>) {
    const token = acquired(await w.make().claim(orderRequest()));
    const response = await w.database.createOrder(token, "book");
    expect(await w.make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    const copy = { ...w.store.records.get(token.storeKey), version: "test-provisional-version", provisional: true } as IdempotencyRecord;
    w.store.records.clear();
    return { token, response, copy };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["the same body", "another body"] as const)("reads the receipt again when its confirmation loses to a newer commit (%s)", async (bodyCase) => {
    const w = world(new AbsenceHookStore());
    const token = acquired(await w.make().claim(orderRequest()));
    await w.database.createOrder(token, "book");
    w.store.records.clear();
    const newer = bodyCase === "the same body" ? orderRequest() : orderRequest({ body: { item: "pen", quantity: 2 } });
    let newerResponse: IdempotentResponse | undefined;
    w.store.afterAbsenceWrite = async () => {
      // Before the confirmation: the copy expires, receipt A is pruned, and B claims, commits and settles.
      beforeNextWrite(w.store, async () => {
        w.clock.advance(60_001);
        w.database.receiptsByKey.clear();
        const other = w.make();
        const newerToken = acquired(await other.claim(newer));
        newerResponse = await w.database.createOrder(newerToken, "pen");
        expect(await other.settle(newerToken, newerResponse)).toMatchObject({ outcome: "settled" });
      });
    };
    const result = await w.make().claim(orderRequest());
    if (bodyCase === "the same body") {
      expect(result).toMatchObject({ outcome: "replay", source: "receipt", response: { body: newerResponse?.body } });
    } else {
      expect(result).toEqual({ outcome: "conflict" });
    }
  });

  it("confirms a live provisional copy it reports on, retrying a failed write", async () => {
    const w = world(new AbsenceHookStore());
    const { token, response, copy } = await provisionalCopy(w);
    w.store.records.set(token.storeKey, copy);
    vi.spyOn(w.store, "compareAndSet").mockRejectedValueOnce(new Error("store write failed"));
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    vi.restoreAllMocks();
    w.database.receiptsByKey.clear();
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "replay", source: "store", response: { body: response.body } });
  });

  it("confirms another writer's provisional copy of the same commit before reporting it", async () => {
    const w = world(new AbsenceHookStore());
    const { token, copy } = await provisionalCopy(w);
    w.store.beforeAbsenceWrite = async () => {
      w.store.records.set(token.storeKey, structuredClone(copy));
    };
    expect(await w.make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    expect(w.store.records.get(token.storeKey)).not.toHaveProperty("provisional");
  });

  it.each(["settle", "release"] as const)("%s decides with its receipt when its applied write throws and the receipt is then pruned", async (action) => {
    const w = world(new FakeAtomicStore());
    const holder = w.make();
    const token = acquired(await holder.claim(orderRequest()));
    const response = await w.database.createOrder(token, "book");
    const original = w.store.compareAndSet.bind(w.store);
    vi.spyOn(w.store, "compareAndSet").mockImplementationOnce(async (...args) => {
      await original(...args);
      w.database.receiptsByKey.clear();
      throw new Error("store acknowledgement lost");
    });
    if (action === "settle") {
      expect(await holder.settle(token, response)).toMatchObject({ outcome: "settled", response: { body: response.body } });
    } else {
      expect(await holder.release(token)).toMatchObject({ outcome: "committed", response: { body: response.body } });
    }
  });

  it.each(["claim", "recover"] as const)("%s keeps the receipt's response when its write loses to a confirmed copy and the receipt is pruned", async (action) => {
    const w = world(new HookedStore());
    const token = acquired(await w.make().claim(orderRequest()));
    const response = await w.database.createOrder(token, "book");
    w.store.arm(token.version, async () => {
      expect(await w.make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
      w.database.receiptsByKey.clear();
    });
    const result = action === "claim" ? await w.make().claim(orderRequest()) : await w.make().recover(orderRequest());
    expect(result).toMatchObject({ outcome: "replay", source: "receipt", response: { body: response.body } });
  });

  /** Expires the order key's copy, prunes its receipts and lets a newer claim commit `body` (and settle it). */
  async function newerCommit(w: ReturnType<typeof world<FakeAtomicStore>>, request: IdempotencyRequest, settle = true) {
    w.clock.advance(60_001);
    w.database.receiptsByKey.clear();
    const other = w.make();
    const token = acquired(await other.claim(request));
    const response = await w.database.createOrder(token, "pen");
    if (settle) expect(await other.settle(token, response)).toMatchObject({ outcome: "settled" });
    return { token, response };
  }

  const otherOrder = () => orderRequest({ body: { item: "pen", quantity: 2 } });

  it.each([
    ["its own copy after a lost acknowledgement", "the same body"],
    ["its own copy after a lost acknowledgement", "another body"],
    ["another writer's provisional copy", "the same body"],
    ["another writer's provisional copy", "another body"],
  ] as const)("reads the receipt again when confirming %s loses to a newer commit (%s)", async (copyCase, bodyCase) => {
    const w = world(new AbsenceHookStore());
    const { token, copy } = await provisionalCopy(w);
    const newer = bodyCase === "the same body" ? orderRequest() : otherOrder();
    let newerResponse: IdempotentResponse | undefined;
    const original = w.store.compareAndSet.bind(w.store);
    const confirmHook = async () => {
      newerResponse = (await newerCommit(w, newer)).response;
    };
    if (copyCase === "another writer's provisional copy") {
      w.store.beforeAbsenceWrite = async () => {
        w.store.records.set(token.storeKey, structuredClone(copy));
        beforeNextWrite(w.store, confirmHook);
      };
    } else {
      vi.spyOn(w.store, "compareAndSet")
        .mockImplementationOnce(async (...args) => {
          await original(...args);
          throw new Error("store acknowledgement lost");
        })
        .mockImplementationOnce(async (...args) => {
          await confirmHook();
          return original(...args);
        });
    }
    const result = await w.make().recover(orderRequest());
    if (bodyCase === "the same body") {
      expect(result).toMatchObject({ outcome: "replay", source: "receipt", response: { body: newerResponse?.body } });
    } else {
      expect(result).toEqual({ outcome: "conflict" });
    }
  });

  it("confirms another writer's provisional copy when its own write's acknowledgement was lost unwritten", async () => {
    const w = world(new AbsenceHookStore());
    const { token, copy } = await provisionalCopy(w);
    vi.spyOn(w.store, "compareAndSet").mockImplementationOnce(async () => {
      w.store.records.set(token.storeKey, structuredClone(copy));
      throw new Error("store acknowledgement lost");
    });
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    expect(w.store.records.get(token.storeKey)).not.toHaveProperty("provisional");
  });

  it("confirms a newer commit's provisional copy found by the recheck after a lost write", async () => {
    const w = world(new HookedStore());
    const token = acquired(await w.make().claim(orderRequest()));
    await w.database.createOrder(token, "book");
    w.store.arm(token.version, async () => {
      // B commits; its record is evicted and a crashed reader leaves an unconfirmed copy of B.
      const { token: newer, response } = await newerCommit(w, orderRequest(), false);
      w.store.records.set(token.storeKey, {
        state: "completed",
        version: "test-provisional-version",
        generation: newer.generation,
        fingerprint: newer.fingerprint,
        recovery: "receipt",
        response,
        expiresAt: w.clock.time + 60_000,
        fromReceipt: true,
        receiptClaimId: newer.claimId,
        provisional: true,
      } as IdempotencyRecord);
    });
    expect(await w.make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
    expect(w.store.records.get(token.storeKey)).not.toHaveProperty("provisional");
    w.database.receiptsByKey.clear();
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "replay", source: "store" });
  });

  it.each(["settle", "release"] as const)("%s never decides from a copy replaced while its lookup ran", async (action) => {
    const store = new HookedStore();
    let duringLookup: (() => Promise<void>) | undefined;
    const database = new FakeOrderDatabase();
    const receipts: IdempotencyReceiptSource = {
      find: async (storeKey: string) => {
        const run = duringLookup;
        duringLookup = undefined;
        if (run) await run();
        return database.receipts.find(storeKey);
      },
    };
    const w = { ...world(store, receipts), database };
    const holder = w.make();
    const token = acquired(await holder.claim(orderRequest()));
    const response = await database.createOrder(token, "book");
    store.arm(token.version, async () => {
      expect(await w.make().recover(orderRequest())).toMatchObject({ outcome: "replay", source: "receipt" });
      // The holder's next lookup: the confirmed copy is replaced by a confirmed copy of another body, then pruned.
      duringLookup = async () => {
        const confirmed = store.records.get(token.storeKey);
        store.records.set(token.storeKey, { ...confirmed, version: "test-newer-version", fingerprint: "test-other-fingerprint", receiptClaimId: "test-other-claim" } as IdempotencyRecord);
        database.receiptsByKey.clear();
      };
    });
    const result = action === "settle" ? await holder.settle(token, response) : await holder.release(token);
    expect(result).toEqual({ outcome: "conflict" });
  });

  it("frees its unused claim when the receipt it found is gone after a failed write", async () => {
    const producer = world(new FakeAtomicStore());
    const holder = acquired(await producer.make().claim(orderRequest()));
    await producer.database.createOrder(holder, "book");
    const receipt = producer.database.receiptsByKey.get(holder.storeKey);
    let lookups = 0;
    // The receipt lands while the claim is written and is pruned right after the claim's recheck.
    const receipts: IdempotencyReceiptSource = { find: async () => ((lookups += 1) === 2 ? receipt : undefined) };
    const w = world(new FakeAtomicStore(), receipts);
    const original = w.store.compareAndSet.bind(w.store);
    vi.spyOn(w.store, "compareAndSet").mockImplementation(async (storeKey, expectedVersion, next) => {
      if (next?.state === "completed" && lookups === 2) throw new Error("store write failed");
      return original(storeKey, expectedVersion, next);
    });
    expect(await w.make().claim(orderRequest())).toMatchObject({ outcome: "acquired" });
  });
});
