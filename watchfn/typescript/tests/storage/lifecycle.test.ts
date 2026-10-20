import { describe, expect, it, vi } from "vitest";
import { WatchFn } from "../../src/core/watch-fn";

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function create(insertEvent: (event: any) => Promise<void> | void) {
  const watch = new WatchFn({ name: "lifecycle", storage: "database", database: { insertEvent, queryEvents: async () => [] }, infra: { enabled: false } });
  watch.start();
  return watch;
}

it("flush waits for pending collector writes and stored data becomes observable", async () => {
  const gate = deferred(), events: any[] = [];
  const watch = create(async event => { await gate.promise; events.push(event); });
  watch.track("queued");
  let done = false;
  const flushing = watch.flush().then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(events).toEqual([]);
  gate.resolve();
  await flushing;
  expect(events.map(event => event.name)).toEqual(["queued"]);
  await watch.stop();
});

it("flush captures a finite admission barrier without waiting for later writes", async () => {
  const first = deferred(), second = deferred();
  const watch = create(event => event.name === "first" ? first.promise : second.promise);
  watch.track("first");
  const flushing = watch.flush();
  watch.track("second");
  first.resolve();
  await flushing;
  let stopped = false;
  const stopping = watch.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  second.resolve(); await stopping;
});

it("stop owns every event in an admitted batch and rejects new admission", async () => {
  const first = deferred(), second = deferred();
  const received: string[] = [];
  const watch = create(async event => { received.push(event.name); await (event.name === "one" ? first.promise : second.promise); });
  const batch = [{ name: "one" }, { name: "two" }];
  const ingesting = watch.ingest(batch);
  batch.push({ name: "not-admitted" });
  const stopping = watch.stop();
  expect(watch.stop()).toBe(stopping);
  expect(watch.started).toBe(false);
  expect(() => watch.start()).toThrow("await stop");
  watch.track("ignored");
  await expect(watch.ingest([{ name: "rejected" }])).rejects.toThrow("unavailable");
  first.resolve();
  await vi.waitFor(() => expect(received).toEqual(["one", "two"]));
  let done = false; void stopping.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  second.resolve(); await Promise.all([ingesting, stopping]);
  expect(received).toEqual(["one", "two"]);
});

it("retains asynchronous background failures until an explicit flush observes them", async () => {
  const failure = new Error("write failed");
  const watch = create(async () => { throw failure; });
  watch.track("lost");
  // No returned rejected storage promise is left unobserved between capture and flush.
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(watch.flush()).rejects.toMatchObject({ errors: [failure] });
  await expect(watch.flush()).resolves.toBeUndefined();
  await watch.stop();
});

it("handles synchronous storage throws and drains all other pending operations", async () => {
  const failure = new Error("synchronous failure"), gate = deferred();
  const watch = create(event => { if (event.name === "bad") throw failure; return gate.promise; });
  expect(() => watch.track("bad")).not.toThrow();
  watch.track("slow");
  const stopped = watch.stop();
  let settled = false; void stopped.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  gate.resolve();
  await expect(stopped).rejects.toMatchObject({ errors: [failure] });
  await expect(watch.flush()).rejects.toMatchObject({ errors: [failure] });
});

it("concurrent flush waiters observe the same failure", async () => {
  const gate = deferred(), failure = new Error("failed");
  const watch = create(() => gate.promise);
  watch.track("one");
  const one = watch.flush(), two = watch.flush();
  const checked = Promise.all([expect(one).rejects.toMatchObject({ errors: [failure] }), expect(two).rejects.toMatchObject({ errors: [failure] })]);
  gate.reject(failure); await checked;
  await expect(watch.flush()).resolves.toBeUndefined();
  await watch.stop();
});

it("ignored stop observes rejections internally but preserves failure for later flush", async () => {
  const gate = deferred(), failure = new Error("later failure");
  const watch = create(() => gate.promise);
  watch.track("pending");
  watch.stop();
  gate.reject(failure);
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(watch.flush()).rejects.toMatchObject({ errors: [failure] });
  await expect(watch.stop()).resolves.toBeUndefined();
});

it("ingest reports persistence failure and stop also observes that admitted batch", async () => {
  const gate = deferred(), failure = new Error("batch failed");
  const watch = create(() => gate.promise);
  const ingesting = watch.ingest([{ name: "one" }, { name: "two" }]);
  const stopped = watch.stop();
  const checked = Promise.all([expect(ingesting).rejects.toBe(failure), expect(stopped).rejects.toMatchObject({ errors: [failure] })]);
  gate.reject(failure); await checked;
  await expect(watch.flush()).rejects.toMatchObject({ errors: [failure] });
});

it("restart after completed stop installs exactly one storage listener", async () => {
  const insert = vi.fn();
  const watch = create(insert);
  watch.start(); watch.track("first"); await watch.stop();
  watch.start(); watch.start(); watch.track("second"); await watch.stop();
  expect(insert.mock.calls.map(call => call[0].name)).toEqual(["first", "second"]);
});

it("cleanup failures cannot skip other collector cleanup or draining", async () => {
  const gate = deferred(), failure = new Error("cleanup failed");
  const watch = create(() => gate.promise);
  const internals = watch as any;
  vi.spyOn(internals.httpInterceptor, "uninstall").mockImplementation(() => { throw failure; });
  const systemStop = vi.spyOn(internals.systemMetrics, "stop");
  const processStop = vi.spyOn(internals.processMetrics, "stop");
  watch.track("pending");
  const stopped = watch.stop();
  expect(systemStop).toHaveBeenCalledOnce(); expect(processStop).toHaveBeenCalledOnce();
  let done = false; void stopped.then(() => { done = true; }, () => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  gate.resolve();
  await expect(stopped).rejects.toMatchObject({ errors: [failure] });
  await expect(watch.flush()).rejects.toMatchObject({ errors: [failure] });
});
