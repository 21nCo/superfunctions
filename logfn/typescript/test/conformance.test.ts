import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  enrichContext,
  redactEvent,
  redactSecFn,
  REDACTED,
  serverLogger,
  sinkHttp,
  type HttpSinkFetch,
  type HttpSinkRequest,
  type LogEvent,
  type PipelineStage,
  type Sink,
} from "../src/index.js";
import {
  PYTHON_PACKAGE_PATH,
  PYTHON_VECTORS_PATH,
  VECTORS_PATH,
  expectVector,
  loadVectors,
  vectorEvent,
  type RedactionVector,
} from "./vectors.js";

const { marker, vectors } = loadVectors();

function fetchSpy() {
  const requests: HttpSinkRequest[] = [];
  const fetch = vi.fn<HttpSinkFetch>(async (_url, init) => {
    requests.push(init);
    return { ok: true, status: 200 };
  });
  const events = () => requests.flatMap((request) => (JSON.parse(request.body) as { events: LogEvent[] }).events);
  return { fetch, requests, events };
}

// Sets fields the Logger API has no argument for, as a caller-added stage would.
function identityStage(vector: RedactionVector): PipelineStage {
  return (event) => ({
    ...event,
    ...(vector.input.userId !== undefined ? { userId: vector.input.userId } : {}),
    ...(vector.input.tenantId !== undefined ? { tenantId: vector.input.tenantId } : {}),
    ...structuredClone(vector.input.fields),
  });
}

function logVector(vector: RedactionVector, pipeline: PipelineStage[], sink: Sink): void {
  const { base, child, enrich } = vector.layers ?? {};
  const root = createLogger({
    name: "vectors",
    level: "trace",
    baseContext: base,
    pipeline: [identityStage(vector), ...(enrich ? [enrichContext(enrich)] : []), ...pipeline],
    sinks: [sink],
  });
  const logger = child ? root.child({ ctx: child }) : root;
  const ctx = vectorEvent({ ...vector, layers: undefined }).ctx;
  logger.error(vector.input.msg, ctx, vector.input.tags);
}

describe("shared redaction vectors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("use the same marker as the runtime", () => {
    expect(marker).toBe(REDACTED);
    expect(vectors.length).toBeGreaterThanOrEqual(12);
  });

  it.skipIf(!existsSync(PYTHON_PACKAGE_PATH))("match the Python copy byte for byte", () => {
    expect(readFileSync(PYTHON_VECTORS_PATH, "utf8")).toBe(readFileSync(VECTORS_PATH, "utf8"));
  });

  describe.each(vectors.map((vector) => [vector.id, vector] as const))("%s", (_id, vector) => {
    it("redaction stage output matches and is idempotent", () => {
      const stage = redactSecFn(vector.options);
      const input = vectorEvent(vector);
      const once = stage(input);
      expect(once).not.toBeNull();
      expectVector(once as LogEvent, vector, "stage");
      expectVector(stage(once as LogEvent) as LogEvent, vector, "stage twice");
      expectVector(redactEvent(vectorEvent(vector), vector.options), vector, "redactEvent");
    });

    it("logger with a redaction stage delivers the expected event", () => {
      const captured: LogEvent[] = [];
      logVector(vector, [redactSecFn(vector.options)], (batch) => {
        captured.push(...batch);
      });
      expect(captured).toHaveLength(1);
      expectVector(captured[0], vector, "logger");
    });

    it("sinkHttp redacts before sending even without a redaction stage", async () => {
      const spy = fetchSpy();
      const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch, redact: vector.options });
      logVector(vector, [], sink);
      await sink.flush();
      expect(spy.fetch).toHaveBeenCalledTimes(1);
      expect(spy.events()).toHaveLength(1);
      expectVector(spy.events()[0], vector, "sinkHttp");
    });

    it("sinkHttp called directly with the raw event sends the expected event", async () => {
      const spy = fetchSpy();
      const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch, redact: vector.options });
      sink([vectorEvent(vector)]);
      await sink.flush();
      expect(spy.events()).toHaveLength(1);
      expectVector(spy.events()[0], vector, "sinkHttp direct");
    });
  });

  it("sinkHttp redacts context added by a stage that runs after the redaction stage", async () => {
    const spy = fetchSpy();
    const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
    const logger = createLogger({
      name: "late-enrichment",
      pipeline: [redactSecFn(), enrichContext({ apiKey: "late-key", dsn: "https://u:late-pw@db.test" })],
      sinks: [sink],
    });
    logger.info("late");
    await sink.flush();
    const body = spy.requests[0].body;
    expect(body).not.toContain("late-key");
    expect(body).not.toContain("late-pw");
    expect(spy.events()[0].ctx).toEqual({ apiKey: REDACTED, dsn: `https://${REDACTED}@db.test` });
  });

  it("no credential in JSON text reaches the sink body, whatever its formatting", async () => {
    // Credential keys at several depths, holding strings, numbers and objects.
    const document = (n: number) => ({
      token: `S${n}_TOP`,
      service: {
        name: "billing",
        auth: { user: "svc", password: `S${n}_NESTED` },
        hosts: [{ host: "a", apiKey: `S${n}_ARRAY` }],
        retries: { client_secret: `S${n}_DEEP`, max: 3 },
      },
      credentials: { id: `S${n}_OBJECT` },
    });
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    const newlineBeforeValue = (text: string) => text.replace(/": /g, '":\n    ');
    const formats: Array<(value: unknown) => string> = [
      (value) => JSON.stringify(value),
      (value) => JSON.stringify(value, null, 2),
      (value) => JSON.stringify(value, null, 4),
      (value) => JSON.stringify(value, null, "\t"),
      (value) => newlineBeforeValue(JSON.stringify(value, null, 2)),
      (value) => crlf(JSON.stringify(value, null, 2)),
      (value) => crlf(newlineBeforeValue(JSON.stringify(value, null, 2))),
    ];
    const escaped = formats.map((format) => (value: unknown) => JSON.stringify(format(value)));
    const all = [...formats, ...escaped];
    const spy = fetchSpy();
    const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch, maxQueue: 1000, batch: 1000 });
    all.forEach((format, n) => {
      sink([{ ts: "2026-01-14T12:00:00.000Z", level: "info", msg: format(document(n)), name: "t", version: "0" }]);
      sink([{ ts: "2026-01-14T12:00:00.000Z", level: "info", msg: "m", name: "t", version: "0", ctx: { text: format(document(n + 100)) } }]);
    });
    await sink.flush();
    expect(spy.events()).toHaveLength(all.length * 2);
    const body = spy.requests.map((request) => request.body).join("\n");
    expect(body.match(/S\d+_[A-Z]+/g)).toBeNull();
    expect(body).toContain("billing");
  });

  it("no secret fragment reaches the sink body when the logger's message is cut at the size limit", async () => {
    // No redaction stage: sinkHttp's own redaction is the only guard, so it
    // must see the whole message, not one cut through a secret's delimiter.
    const secrets = [
      "https://u:QJURL1@host.test/path",
      "contact qjmail.user@example.com today",
      "Authorization: Bearer QJBEARER\n",
      '{"password":"QJJSON"}',
      "https://h.test/cb?token=QJQUERY&next=1",
    ];
    const spy = fetchSpy();
    const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch, maxQueue: 5000, batch: 5000 });
    const logger = createLogger({ name: "t", level: "trace", sinks: [sink] });
    const child = logger.child({ name: "child" });
    // Characters of an oversized message the sink keeps (everything is ASCII).
    logger.info("x".repeat(100_000));
    await logger.flush();
    const kept = spy.events()[0].msg.length - "...[truncated]".length;
    spy.requests.length = 0;
    let logged = 0;
    for (const secret of secrets) {
      for (const target of [logger, child]) {
        // Cuts from just before the secret to just after it.
        for (let start = kept - secret.length - 4; start <= kept + 2; start++) {
          target.info(`${"x".repeat(start - 1)} ${secret} ${"z".repeat(2000)}`);
          logged += 1;
        }
      }
    }
    await logger.flush();
    const events = spy.events();
    expect(events).toHaveLength(logged);
    for (const sent of events) expect(sent.msg.endsWith("...[truncated]")).toBe(true);
    const body = spy.requests.map((request) => request.body).join("\n");
    expect(body.match(/qj\w*/gi)).toBeNull();
    expect(body).toContain(REDACTED);
  });

  it("serverLogger with a url redacts before its HTTP sink", async () => {
    const spy = fetchSpy();
    vi.stubGlobal("fetch", spy.fetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = serverLogger({ name: "server", url: "https://collector.test/ingest" });
    logger.error("db down postgres://svc:pw-123@db/app", { password: "hunter2", token: "t-1" });
    await logger.flush();
    expect(spy.fetch).toHaveBeenCalledTimes(1);
    const body = spy.requests[0].body;
    for (const secret of ["pw-123", "hunter2", "t-1"]) expect(body).not.toContain(secret);
  });

  it("serverLogger redacts the text of a date before the console", () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });
    }
    const when = new Date("2026-01-01T00:00:00.000Z");
    when.toISOString = () => "token=DATE_SECRET";
    serverLogger({ name: "svc" }).error("date", { when });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("token=[redacted]");
    expect(lines[0]).not.toContain("DATE_SECRET");
  });

  it("serverLogger redacts a credential-bearing error name before the console", () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });
    }
    const error = new Error("failed", { cause: new Error("refused") });
    error.name = "RemoteError token=NAME_SECRET";
    (error.cause as Error).name = "Upstream https://u:CAUSE_SECRET@h.test/x";
    serverLogger({ name: "svc" }).error("failed", error);
    const output = lines.join("\n");
    expect(lines).toHaveLength(1);
    expect(output).toContain("RemoteError token=[redacted]");
    expect(output).not.toContain("NAME_SECRET");
    expect(output).not.toContain("CAUSE_SECRET");
  });
});
