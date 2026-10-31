import net from "node:net";
import dns from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  devLogger,
  enrichContext,
  redactSecFn,
  sample,
  serverLogger,
  sinkHttp,
  withRequestIds,
} from "../src/index.js";

describe("default logger configurations perform no network I/O", () => {
  const spies: Array<ReturnType<typeof vi.fn>> = [];

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const transport = () => {
      const spy = vi.fn(() => {
        throw new Error("network I/O attempted");
      });
      spies.push(spy);
      return spy;
    };
    vi.stubGlobal("fetch", transport());
    vi.stubGlobal("XMLHttpRequest", transport());
    vi.stubGlobal("WebSocket", transport());
    vi.stubGlobal("navigator", { sendBeacon: transport() });
    spies.push(vi.spyOn(net.Socket.prototype, "connect") as never);
    spies.push(vi.spyOn(dns, "lookup") as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    spies.length = 0;
  });

  it("createLogger, devLogger and serverLogger without a url only write locally", async () => {
    const loggers = [
      createLogger({ name: "default" }),
      createLogger({
        name: "full-pipeline",
        level: "trace",
        pipeline: [withRequestIds(), enrichContext({ app: "a" }), redactSecFn(), sample({ info: 1 })],
      }),
      devLogger("dev"),
      serverLogger({ name: "server" }),
    ];
    for (const logger of loggers) {
      for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
        logger[level]("message https://u:p@example.com", { error: new Error("boom") });
      }
      await logger.flush();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalled();
  });

  it("constructing an HTTP sink sends nothing until events are logged", async () => {
    const fetch = vi.fn();
    const sink = sinkHttp({ url: "https://collector.test/ingest", fetch, flushIntervalMs: 1 });
    await sink.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
