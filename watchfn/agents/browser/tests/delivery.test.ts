import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserClient } from "../src/index";

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://app.test/path", pathname: "/path" } });
  vi.stubGlobal("navigator", { userAgent: "test-browser" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const setup = (options = {}) => new BrowserClient({ endpoint: "https://watch.test/ingest", projectId: "project", autoTrack: false,
  retryDelayMs: 0, retries: 0, onError: vi.fn(), ...options });

it("joins concurrent flushes and preserves events added while delivery is pending", async () => {
  let release!: (response: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  const client = setup();
  const properties = { count: 1 };
  client.track("first", properties); properties.count = 2;
  const first = client.flush();
  expect(client.flush()).toBe(first);
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  client.track("second");
  expect(client.pendingCount).toBe(2);
  release(new Response(null, { status: 202 }));
  await first;
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)[0].properties).toEqual({ count: 1 });
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)[0].name).toBe("second");
  expect(client.pendingCount).toBe(0);
});

it.each([408, 429, 500, 503])("retries transient HTTP %s with bounded attempts and retained batch", async status => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  const client = setup({ retries: 1 }); client.track("event");
  await client.flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
  expect(client.pendingCount).toBe(0);
});

it("retains exhausted network failures and permits explicit recovery", async () => {
  const errors = vi.fn();
  const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", fetchMock);
  const client = setup({ retries: 2, onError: errors }); client.track("event");
  await expect(client.flush()).rejects.toThrow("offline");
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(client.pendingCount).toBe(1);
  expect(errors).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  await client.flush(); expect(client.pendingCount).toBe(0);
});

it("does not retry terminal statuses and reads refreshed authentication on recovery", async () => {
  let key = "expired";
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  const client = setup({ retries: 5, apiKey: () => key, headers: { "x-custom": "value" } });
  client.track("event"); await expect(client.flush()).rejects.toMatchObject({ status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(client.pendingCount).toBe(1);
  key = "valid"; await client.flush();
  expect(fetchMock.mock.calls[0][1].headers.get("authorization")).toBe("Bearer expired");
  expect(fetchMock.mock.calls[1][1].headers.get("authorization")).toBe("Bearer valid");
  expect(fetchMock.mock.calls[1][1].headers.get("x-custom")).toBe("value");
});

it("times out, aborts fetch, and retains the unacknowledged event", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(() => new Promise(() => {})); vi.stubGlobal("fetch", fetchMock);
  const client = setup({ timeoutMs: 20 }); client.track("event");
  const result = expect(client.flush()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20); await result;
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(client.pendingCount).toBe(1);
});

it("bounds queues without discarding previously accepted events and supports retryable close", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  const client = setup({ maxQueueSize: 1 }); client.track("first");
  expect(() => client.track("overflow")).toThrow("queue is full");
  await expect(client.close()).rejects.toMatchObject({ status: 503 });
  expect(client.pendingCount).toBe(1);
  expect(() => client.track("closed")).toThrow("closed");
  await client.close(); expect(client.pendingCount).toBe(0);
});

it("bounds batches by bytes and rejects oversized/circular events synchronously", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(null, { status: 202 })); vi.stubGlobal("fetch", fetchMock);
  const client = setup({ batchSize: 500 });
  expect(() => client.track("large", { value: "😀".repeat(17000) })).toThrow("64 KiB");
  const cycle: any = {}; cycle.self = cycle;
  expect(() => client.track("cycle", cycle)).toThrow();
  for (let i = 0; i < 30; i++) client.track("event", { value: "a".repeat(60000) });
  await client.flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [, options] of fetchMock.mock.calls) expect(new TextEncoder().encode(options.body).length).toBeLessThanOrEqual(1024 * 1024);
});

it("disconnects RUM observers on close and isolates error callback exceptions", async () => {
  const disconnect = vi.fn();
  vi.stubGlobal("PerformanceObserver", class { observe() {} disconnect = disconnect; });
  vi.stubGlobal("document", { referrer: "", title: "page" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  const client = setup({ autoTrack: true, onError: () => { throw new Error("callback failure"); } });
  await expect(client.close()).rejects.toMatchObject({ status: 503 });
  expect(disconnect).toHaveBeenCalledTimes(3); expect(client.pendingCount).toBe(1);
});

it("validates delivery limits and honors explicit zero sampling", async () => {
  expect(() => setup({ retries: -1 })).toThrow("Invalid retries");
  expect(() => setup({ timeoutMs: 0 })).toThrow("Invalid timeoutMs");
  expect(() => setup({ sampleRate: NaN })).toThrow("sampleRate");
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const client = setup({ sampleRate: 0 }); client.track("ignored"); await client.flush();
  expect(fetchMock).not.toHaveBeenCalled();
});
