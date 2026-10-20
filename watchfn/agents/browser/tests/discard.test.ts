import { afterEach, expect, it, vi } from "vitest";
import { BrowserClient, BrowserDeliveryError, BrowserDeliveryDiscardedError } from "../src/index";

const setup = (options = {}) => new BrowserClient({ endpoint: "https://watch.test/ingest", projectId: "app", autoTrack: false,
  retries: 2, retryDelayMs: 1000, timeoutMs: 60000, ...options });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("discards before the delivery microtask without sending and counts only owned entries", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 })); vi.stubGlobal("fetch", fetch);
  const client = setup();
  const capture = client.capture({ id: "old" }); const flush = client.flush();
  const rejected = expect(capture).rejects.toBeInstanceOf(BrowserDeliveryDiscardedError);
  const rejectedFlush = expect(flush).rejects.toBeInstanceOf(BrowserDeliveryError);
  expect(client.discardPending()).toBe(1); expect(client.discardPending()).toBe(0);
  await Promise.all([rejected, rejectedFlush]); expect(fetch).not.toHaveBeenCalled();
  expect(client.discardedCount).toBe(1); expect(client.pendingCount).toBe(0);
  await client.capture({ id: "new" }); expect(fetch).toHaveBeenCalledTimes(1);
  expect(client.discardPending()).toBe(0); expect(client.discardedCount).toBe(1);
});

it.each([202, 503])("fences late HTTP %s from an abort-ignoring request and preserves new drain ownership", async status => {
  const releases: Array<(response: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>(resolve => releases.push(resolve))); vi.stubGlobal("fetch", fetch);
  const client = setup();
  const old = client.capture({ id: "same" }); const oldFlush = client.flush();
  const rejected = expect(old).rejects.toBeInstanceOf(BrowserDeliveryDiscardedError);
  const rejectedFlush = expect(oldFlush).rejects.toBeInstanceOf(BrowserDeliveryDiscardedError);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(client.discardPending()).toBe(1);
  expect((fetch.mock.calls[0] as any)[1].signal.aborted).toBe(true);
  const fresh = client.capture({ id: "same" }); const freshFlush = client.flush();
  await Promise.all([rejected, rejectedFlush]);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(client.flush()).toBe(freshFlush); expect(client.pendingCount).toBe(1);
  releases[0](new Response(null, { status }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(client.flush()).toBe(freshFlush); expect(client.pendingCount).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  releases[1](new Response(null, { status: 202 })); await fresh;
  expect(client.pendingCount).toBe(0); expect(client.discardedCount).toBe(1);
});

it("cancels retry waits immediately and removes the retry timer", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 503 })); vi.stubGlobal("fetch", fetch);
  const client = setup(); const capture = client.capture({ id: "retry" });
  const rejected = expect(capture).rejects.toBeInstanceOf(BrowserDeliveryDiscardedError);
  await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1); expect(client.discardPending()).toBe(1);
  await rejected; expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100000); expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async () => new Response(null, { status: 202 }));
  await client.capture({ id: "recovered" }); expect(client.pendingCount).toBe(0);
});

it("settles a permanently hung request promptly and preserves close semantics", async () => {
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue(new Response(null, { status: 202 })); vi.stubGlobal("fetch", fetch);
  const client = setup(); const old = client.capture({ id: "hung" });
  const rejected = expect(old).rejects.toBeInstanceOf(BrowserDeliveryDiscardedError);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  client.discardPending(); await rejected;
  const fresh = client.capture({ id: "new" }); await client.close(); await fresh;
  expect(client.discardedCount).toBe(1); expect(client.pendingCount).toBe(0);
  await expect(client.capture({ id: "closed" })).rejects.toThrow("closed");
});

it("counts the in-flight batch and unsent tail once, without reopening a closed client", async () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
  const client = setup({ batchSize: 1 });
  const captures = [1, 2, 3].map(id => client.capture({ id }));
  const settled = Promise.all(captures.map(capture => expect(capture).rejects.toBeInstanceOf(BrowserDeliveryDiscardedError)));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const closed = expect(client.close()).rejects.toBeInstanceOf(BrowserDeliveryDiscardedError);
  expect(client.discardPending()).toBe(3); await settled; await closed;
  expect(client.pendingCount).toBe(0); expect(client.discardedCount).toBe(3);
  await client.close();
  await expect(client.capture({ id: 4 })).rejects.toThrow("closed");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects admission when toJSON discards its generation without sending the event", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 })); vi.stubGlobal("fetch", fetch);
  const client = setup();
  await expect(client.capture({ toJSON() { client.discardPending(); return { id: "withdrawn" }; } }))
    .rejects.toBeInstanceOf(BrowserDeliveryDiscardedError);
  expect(client.pendingCount).toBe(0); expect(client.discardedCount).toBe(0);
  await client.flush(); expect(fetch).not.toHaveBeenCalled();
  await client.capture({ id: "later" }); expect(fetch).toHaveBeenCalledTimes(1);
});

it("rechecks queue capacity after serialization reenters capture", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 })); vi.stubGlobal("fetch", fetch);
  const client = setup({ maxQueueSize: 1 }); let inner!: Promise<void>;
  const outer = client.capture({ toJSON() { inner = client.capture({ id: "inner" }); return { id: "outer" }; } });
  await expect(outer).rejects.toThrow("queue is full"); await inner;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual([{ id: "inner" }]);
  expect(client.pendingCount).toBe(0);
});

it("rechecks closed state after serialization reenters close", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 })); vi.stubGlobal("fetch", fetch);
  const client = setup(); let closed!: Promise<void>;
  await expect(client.capture({ toJSON() { closed = client.close(); return { id: "closed" }; } }))
    .rejects.toThrow("closed");
  await closed; expect(client.pendingCount).toBe(0); expect(fetch).not.toHaveBeenCalled();
});
