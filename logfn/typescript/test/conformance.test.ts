import { readFileSync } from "node:fs";
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

  it("use the same marker as the runtime and match the Python copy byte for byte", () => {
    expect(marker).toBe(REDACTED);
    expect(vectors.length).toBeGreaterThanOrEqual(9);
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
});
