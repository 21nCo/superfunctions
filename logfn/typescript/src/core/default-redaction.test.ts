import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { Logger } from "./logger.js";
import { devLogger, serverLogger } from "./factory.js";
import { sinkHttp } from "../sinks/http.js";
import { sinkConsole } from "../sinks/console.js";
import type { LogEvent } from "../types.js";

describe("default terminal privacy boundary", () => {
  it("scrubs secret keys, identities and credential text without a configured stage", () => {
    const events: LogEvent[] = [];
    const logger = new Logger({ name: "app", sinks: [batch => { events.push(...batch); }], correlation: { userId: "private-user", tenantId: "private-tenant", traceId: "a".repeat(32) } });
    const input = { password: "hunter2", headers: { Authorization: "Basic abc==", Cookie: "session=private" }, nested: [{ api_key: "opaque", refreshToken: "refresh", safe: "kept" }], tokenCount: 7 };
    logger.info("Authorization: Bearer a.b.c password=hidden contact=user@example.com", input);
    expect(events[0].ctx).toEqual({ password: "[redacted]", headers: { Authorization: "[redacted]", Cookie: "[redacted]" }, nested: [{ api_key: "[redacted]", refreshToken: "[redacted]", safe: "kept" }], tokenCount: 7 });
    expect(events[0].userId).toBe("[redacted]"); expect(events[0].tenantId).toBe("[redacted]"); expect(events[0].traceId).toBe("a".repeat(32));
    for (const value of ["hunter2", "abc==", "private-user", "private-tenant", "a.b.c", "hidden", "user@example.com"]) expect(JSON.stringify(events)).not.toContain(value);
    expect(input.password).toBe("hunter2"); expect(input.nested[0].api_key).toBe("opaque");
  });

  it("runs after custom stages, errors, serializers and cycles without mutating input", () => {
    const events: LogEvent[] = [];
    const error = new Error("token=error-secret");
    const context: any = { error, custom: { toJSON: () => ({ token: "serializer-secret" }) }, safe: "safe" }; context.self = context;
    Object.defineProperty(context, "getter", { enumerable: true, get() { return { password: "getter-secret" }; } });
    const logger = new Logger({ name: "app", sinks: [batch => { events.push(...batch); }], pipeline: [event => ({ ...event, extra: { clientSecret: "later-secret" }, ctx: { ...event.ctx, token: "pipeline-secret" } }) as LogEvent] });
    logger.info("safe", context);
    const json = JSON.stringify(events);
    for (const value of ["error-secret", "serializer-secret", "getter-secret", "later-secret", "pipeline-secret"]) expect(json).not.toContain(value);
    expect(json).toContain("[circular]"); expect(context.error).toBe(error); expect(context.self).toBe(context);
  });

  it("scrubs quoted JSON credential fields, including escaped quotes", () => {
    const events: LogEvent[] = [];
    const logger = new Logger({ name: "app", sinks: [batch => { events.push(...batch); }] });
    logger.info(JSON.stringify({ password: 'json-secret"tail', token: "json-token", authorization: "Basic json-auth", safe: "kept" }));
    for (const value of ["json-secret", "tail", "json-token", "json-auth"]) expect(events[0].msg).not.toContain(value);
    expect(events[0].msg).toContain("kept");
  });

  it("uses exact immutable JSON Pointer leaf opt-ins inherited by children", () => {
    const events: LogEvent[] = []; const allowlist = ["/userId", "/ctx/safe/token", "/ctx/credentials", "/ctx/literal~1key/token"];
    const logger = new Logger({ name: "app", sinks: [batch => { events.push(...batch); }], redaction: { allowlist }, correlation: { userId: "allowed", tenantId: "private" } });
    allowlist.push("/tenantId", "/ctx/unrelated/token");
    logger.child({}).info("safe", { safe: { token: "public" }, unrelated: { token: "private" }, credentials: { token: "still-private" }, "literal/key": { token: "literal-public" }, literal: { key: { token: "nested-private" } } });
    expect(events[0].userId).toBe("allowed"); expect(events[0].tenantId).toBe("[redacted]");
    expect(events[0].ctx).toEqual({ safe: { token: "public" }, unrelated: { token: "[redacted]" }, credentials: "[redacted]", "literal/key": { token: "literal-public" }, literal: { key: { token: "[redacted]" } } });
    for (const invalid of [false, { allowlist: [""] }, { allowlist: ["ctx.token"] }, { allowlist: ["/ctx/~invalid"] }]) expect(() => new Logger({ name: "app", sinks: [() => {}], redaction: invalid as any })).toThrow(TypeError);
  });

  it("isolates sink mutation and preserves literal prototype keys and final byte bounds", () => {
    const events: LogEvent[] = [];
    const logger = new Logger({ name: "app", sinks: [batch => { batch[0].ctx!.password = "sink-mutated"; }, batch => { events.push(...batch); }] });
    logger.info("safe", JSON.parse('{"password":"private","__proto__":{"token":"prototype-secret"}}'));
    expect(events[0].ctx!.password).toBe("[redacted]"); expect(Object.hasOwn(events[0].ctx!, "__proto__")).toBe(true);
    expect((events[0].ctx!.__proto__ as any).token).toBe("[redacted]"); expect(({} as any).token).toBeUndefined();
    logger.info("x".repeat(64000), Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`item${index}`, { token: "a" }])));
    expect(Buffer.byteLength(JSON.stringify(events[1]))).toBeLessThanOrEqual(65536);
  });

  it("emits only masked values through actual console presets and internal diagnostics", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {}); const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      devLogger("app").info("password=dev-secret", { token: "dev-token" }); serverLogger({ name: "app" }).info("safe", { password: "server-secret" });
      new Logger({ name: "app", sinks: [() => { throw new Error("Authorization: Bearer diagnostic.secret"); }] }).info("safe");
      const stage = () => { throw new Error("stage failure"); };
      Object.defineProperty(stage, "name", { value: "password=private-stage-name" });
      new Logger({ name: "app", sinks: [() => {}], pipeline: [stage] }).info("safe");
      const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      for (const value of ["dev-secret", "dev-token", "server-secret", "diagnostic.secret", "private-stage-name"]) expect(output).not.toContain(value);
      expect(output).toContain("[redacted]");
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  it("delivers final masked JSON over actual local HTTP alongside console output", async () => {
    let received: any; const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk); received = JSON.parse(Buffer.concat(chunks).toString()); response.writeHead(202); response.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const sink = sinkHttp({ url: `http://127.0.0.1:${(server.address() as any).port}`, batch: 100, retry: { attempts: 1 } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const logger = new Logger({ name: "app", sinks: [sinkConsole({ json: true }), sink], pipeline: [event => ({ ...event, ctx: { password: "after-pipeline" } })] });
      logger.child({}).info("Bearer header.payload.signature"); await logger.flush();
      expect(received.events[0].ctx.password).toBe("[redacted]"); expect(received.events[0].msg).toBe("[redacted]");
      expect(JSON.stringify(log.mock.calls)).not.toContain("after-pipeline");
    } finally { log.mockRestore(); await sink.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
