import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EVENT_SIZE, createLogger, sinkConsole, type LogEvent } from "../src/index.js";

const event = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  ts: "2026-01-14T12:00:00.000Z",
  level: "info",
  msg: "hello",
  name: "svc",
  version: "0",
  ...overrides,
});

describe("sinkConsole", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes JSON lines routed by level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sinkConsole({ json: true })([event(), event({ level: "warn" }), event({ level: "fatal" })]);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(event());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("pretty-prints context, tags and ids without color when disabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    sinkConsole({ json: false, color: false })([
      event({ ctx: { a: 1 }, tags: ["t"], traceId: "0af7651916cd43dd8448eb211c80319c" }),
    ]);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("INFO  [svc] hello");
    expect(line).toContain('{"a":1}');
    expect(line).toContain("#t");
    expect(line).toContain("trace=0af76519");
    expect(line).not.toContain("\x1b[");
  });

  it("bounds each event itself, since loggers pass events without a size bound", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger({ name: "svc", level: "info", sinks: [sinkConsole({ json: true })] });
    logger.info("€".repeat(40_000), { blob: "x".repeat(70_000) });
    const line = log.mock.calls[0][0] as string;
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(MAX_EVENT_SIZE);
    expect(JSON.parse(line)).toMatchObject({ ctx: { _truncated: true }, msg: expect.stringMatching(/\.\.\.\[truncated\]$/) });
  });
});
