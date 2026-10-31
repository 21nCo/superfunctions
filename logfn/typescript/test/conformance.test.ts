import { existsSync, readFileSync } from "node:fs";
import { isNativeError } from "node:util/types";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  enrichContext,
  isValidLogEvent,
  redactEvent,
  redactSecFn,
  REDACTED,
  sanitizeEvent,
  sanitizeValue,
  serverLogger,
  sinkConsole,
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
  logger.error(vector.input.msg, ctx, vector.input.tags as string[] | undefined);
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

  it("serverLogger writes a date's built-in text, never an override's, before the console", () => {
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
    expect(lines[0]).toContain("2026-01-01T00:00:00.000Z");
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
  describe("output is plain data, so serialization runs no caller code", () => {
    // Array.prototype.map and slice follow Symbol.species, so a copy made with
    // them keeps a subclass and its toJSON, which JSON.stringify later runs.
    class Items extends Array {
      toJSON() {
        return { password: "ARRAY_TOJSON_SECRET" };
      }
    }
    class Species extends Array {
      static get [Symbol.species](): ArrayConstructor {
        return Items as unknown as ArrayConstructor;
      }
    }
    const proxied = () =>
      new Proxy(["safe"], {
        get: (target, key, receiver) => (key === "constructor" ? Items : Reflect.get(target, key, receiver)),
      });
    const hostile = () => ({
      items: Items.of("safe"),
      nested: { list: [Items.of("deep")] },
      species: Species.of("safe"),
      proxy: proxied(),
      hooked: { toJSON: () => ({ password: "OWN_TOJSON_SECRET" }) },
    });
    const hostileTags = () => Items.of("t") as unknown as string[];
    const SECRETS = ["ARRAY_TOJSON_SECRET", "OWN_TOJSON_SECRET"];
    const expectPlain = (ctx: Record<string, any>) => {
      for (const array of [ctx.items, ctx.nested.list, ctx.nested.list[0], ctx.species, ctx.proxy]) {
        expect(Object.getPrototypeOf(array)).toBe(Array.prototype);
      }
    };
    const expectNoSecret = (text: string) => {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    };

    it("redactEvent, redactSecFn and sanitizeValue return plain arrays and no functions", () => {
      const input = { ...vectorEvent(vectors[0]), ctx: hostile(), tags: hostileTags() };
      for (const out of [redactEvent(input), redactSecFn()(input) as LogEvent]) {
        expectPlain(out.ctx as Record<string, any>);
        expect(Object.getPrototypeOf(out.tags)).toBe(Array.prototype);
        expect((out.ctx as Record<string, any>).hooked).toEqual({ toJSON: "[unserializable]" });
        expectNoSecret(JSON.stringify(out));
        expect(JSON.parse(JSON.stringify(out)).ctx.items).toEqual(["safe"]);
      }
      const sanitized = sanitizeValue(hostile()) as Record<string, any>;
      expectPlain(sanitized);
      expectNoSecret(JSON.stringify(sanitized));
    });

    it("sinkHttp sends no secret through a logger or a direct call", async () => {
      const spy = fetchSpy();
      const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
      createLogger({ name: "plain", sinks: [sink] }).info("m", hostile());
      sink([{ ...vectorEvent(vectors[0]), ctx: hostile(), tags: hostileTags() }]);
      await sink.flush();
      expectNoSecret(spy.requests.map((request) => request.body).join("\n"));
      const [logged, direct] = spy.events();
      expect((logged.ctx as Record<string, any>).items).toEqual(["safe"]);
      expect(direct.tags).toEqual(["t"]);
    });

    it("serverLogger console JSON holds no secret", () => {
      const lines: string[] = [];
      for (const method of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          lines.push(String(args[0]));
        });
      }
      serverLogger({ name: "svc" }).error("arrays", hostile());
      expect(lines).toHaveLength(1);
      expectNoSecret(lines[0]);
      expect(lines[0]).toContain('"items":["safe"]');
    });
  });

  describe("wrapped primitives are written as their primitive, never split into characters", () => {
    // Walking `new String(text)` by its keys gives one character per key,
    // which no text rule can match. A hostile toString must not run either.
    const hostileString = () =>
      Object.assign(new String("token=BOXED_SECRET_1"), {
        toString: () => "token=TOSTRING_SECRET",
        valueOf: () => "token=VALUEOF_SECRET",
      });
    const kinds: Array<[string, () => unknown, unknown]> = [
      ["String", () => new String("token=BOXED_SECRET_1"), "token=[redacted]"],
      ["String with own toString and valueOf", hostileString, "token=[redacted]"],
      ["String with a spoofed tag", () => Object.assign(new String("token=BOXED_SECRET_1"), { [Symbol.toStringTag]: "Plain" }), "token=[redacted]"],
      ["Number", () => new Number(42), 42],
      ["non-finite Number", () => new Number(Infinity), "Infinity"],
      ["Boolean", () => new Boolean(false), false],
      ["BigInt", () => Object(10n), "[unserializable]"],
      ["Symbol", () => Object(Symbol("BOXED_SECRET_1")), "[unserializable]"],
    ];
    const SECRETS = ["BOXED_SECRET", "TOSTRING_SECRET", "VALUEOF_SECRET"];
    const expectNoSecret = (text: string) => {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    };
    const boxedTag = () => new String("token=BOXED_SECRET_2") as unknown as string;
    const input = (make: () => unknown): LogEvent => ({
      ...vectorEvent(vectors[0]),
      ctx: { value: make(), nested: { list: [make()] } },
      tags: [boxedTag()],
    });

    describe.each(kinds)("%s", (_kind, make, expected) => {
      it("redactEvent, redactSecFn and sanitizeValue", () => {
        for (const out of [redactEvent(input(make)), redactSecFn()(input(make)) as LogEvent]) {
          const text = JSON.stringify(out);
          expectNoSecret(text);
          expect(JSON.parse(text).ctx).toEqual({ value: expected, nested: { list: [expected] } });
          expect(out.tags).toEqual(["token=[redacted]"]);
        }
        const sanitized = sanitizeValue({ value: make() }) as Record<string, unknown>;
        expect(typeof sanitized.value).not.toBe("object");
        expect(JSON.stringify(sanitized)).not.toContain('"0":');
      });

      it("sinkHttp through a logger and a direct call, ctx and tags", async () => {
        const spy = fetchSpy();
        const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
        createLogger({ name: "boxed", sinks: [sink] }).info("m", { value: make() }, [boxedTag()]);
        sink([input(make)]);
        await sink.flush();
        expectNoSecret(spy.requests.map((request) => request.body).join("\n"));
        const [logged, direct] = spy.events();
        expect(logged.ctx).toEqual({ value: expected });
        expect(logged.tags).toEqual(["token=[redacted]"]);
        expect(direct.ctx).toEqual({ value: expected, nested: { list: [expected] } });
        expect(direct.tags).toEqual(["token=[redacted]"]);
      });

      it("serverLogger console JSON", () => {
        const lines: string[] = [];
        for (const method of ["log", "info", "warn", "error", "debug"] as const) {
          vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
            lines.push(String(args[0]));
          });
        }
        serverLogger({ name: "svc" }).error("boxed", { value: make() }, [boxedTag()]);
        expect(lines).toHaveLength(1);
        expectNoSecret(lines[0]);
        expect(JSON.parse(lines[0]).ctx).toEqual({ value: expected });
      });
    });

    it("a proxy is read as an object, as JSON.stringify reads it", () => {
      const proxy = new Proxy(new String("ab"), {});
      expect(sanitizeValue(proxy)).toEqual(JSON.parse(JSON.stringify(proxy)));
    });
  });

  describe("a non-record context or tags value is never spread into one key per character or byte", () => {
    const kinds: Array<[string, () => unknown, unknown]> = [
      ["String wrapper", () => new String("token=CTX_SECRET"), "token=[redacted]"],
      ["Buffer", () => Buffer.from("password=CTX_SECRET"), "[unserializable]"],
      ["Uint8Array", () => new TextEncoder().encode("password=CTX_SECRET"), "[unserializable]"],
    ];
    const asCtx = (value: unknown) => value as Record<string, unknown>;
    const expectClean = (text: string) => {
      expect(text).not.toContain("CTX_SECRET");
      expect(text).not.toContain("TAG_SECRET");
      expect(text).not.toContain('"0":');
      expect(text).not.toMatch(/112,\s*97,\s*115/);
      expect(text).not.toContain('"t","o","k"');
    };
    const loggers = (make: () => unknown, sinks: Sink[], pipeline: PipelineStage[] = []) => {
      const root = createLogger({ name: "ctx", sinks, pipeline });
      return [
        root,
        createLogger({ name: "ctx", sinks, pipeline, baseContext: asCtx(make()) }),
        root.child({ ctx: asCtx(make()) }),
      ];
    };

    describe.each(kinds)("%s", (_kind, make, expected) => {
      it("sinkHttp body as call ctx, baseContext and child ctx", async () => {
        const spy = fetchSpy();
        const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
        for (const logger of loggers(make, [sink])) logger.info("m", asCtx(make()));
        await sink.flush();
        expectClean(spy.requests.map((request) => request.body).join("\n"));
        expect(spy.events().map((event) => event.ctx)).toEqual([{ value: expected }, { value: expected }, { value: expected }]);
      });

      it("serverLogger console JSON as call ctx and child ctx, and a redacting console logger with baseContext", () => {
        const lines: string[] = [];
        for (const method of ["log", "info", "warn", "error", "debug"] as const) {
          vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
            lines.push(String(args[0]));
          });
        }
        const server = serverLogger({ name: "svc" });
        server.error("m", asCtx(make()));
        server.child({ ctx: asCtx(make()) }).error("m");
        const consoleSink = sinkConsole({ json: true, color: false });
        createLogger({ name: "ctx", sinks: [consoleSink], pipeline: [redactSecFn()], baseContext: asCtx(make()) }).error("m");
        expect(lines).toHaveLength(3);
        for (const line of lines) {
          expectClean(line);
          expect(JSON.parse(line).ctx).toEqual({ value: expected });
        }
      });
    });

    it("a string or String wrapper as baseTags, child tags or log tags is not split into characters", async () => {
      const spy = fetchSpy();
      const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
      const text = () => "token=TAG_SECRET" as unknown as string[];
      const boxed = () => new String("token=TAG_SECRET") as unknown as string[];
      const root = createLogger({ name: "tags", sinks: [sink], baseTags: text() });
      root.info("base string");
      createLogger({ name: "tags", sinks: [sink], baseTags: boxed() }).info("base wrapper");
      root.child({ tags: text() }).info("child string");
      root.child({ tags: boxed() }).info("child wrapper", undefined, boxed());
      root.child({ tags: ["kept"] }).info("array", undefined, ["also"]);
      await sink.flush();
      expectClean(spy.requests.map((request) => request.body).join("\n"));
      expect(spy.events().map((event) => event.tags)).toEqual([undefined, undefined, undefined, undefined, ["kept", "also"]]);
    });
  });

  describe("an object-valued tag never reaches a sink as JSON text, where its keys would escape redaction", () => {
    const tag = () => ({ "api/key": "TAG_SLASH_SECRET", "pass\nword": "TAG_NL_SECRET", deep: { secret: "TAG_DEEP_SECRET" } });
    const tags = () => ["kept", tag(), [tag()]] as unknown as string[];
    const expected = ["kept", "[unserializable]", "[unserializable]"];
    const expectNoSecret = (text: string) => expect(text).not.toMatch(/TAG_(SLASH|NL|DEEP)_SECRET/);

    it("sinkHttp body, called directly and through a logger with call, base and child tags", async () => {
      const spy = fetchSpy();
      const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
      sink([{ ...vectorEvent(vectors[0]), tags: tags() }]);
      const logger = createLogger({ name: "svc", sinks: [sink], baseTags: [tag()] as unknown as string[] });
      logger.info("call", undefined, tags());
      logger.child({ tags: tags() }).info("child");
      await sink.flush();
      expectNoSecret(spy.requests.map((request) => request.body).join("\n"));
      expect(spy.events().map((event) => event.tags)).toEqual([expected, ["[unserializable]", ...expected], ["[unserializable]", ...expected]]);
    });

    it("serverLogger console JSON, redactEvent and redactSecFn write the same tags", () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));
      serverLogger({ name: "svc" }).info("m", undefined, tags());
      expect(lines).toHaveLength(1);
      expectNoSecret(lines[0]);
      expect((JSON.parse(lines[0]) as LogEvent).tags).toEqual(expected);
      const event = { ...vectorEvent(vectors[0]), tags: tags() };
      for (const out of [redactEvent(event), redactSecFn()(event) as LogEvent, sanitizeEvent(event)]) {
        expect(out.tags).toEqual(expected);
        expectNoSecret(JSON.stringify(out));
      }
    });
  });

  describe("values from another realm (a vm context, an iframe) keep their kind", () => {
    const foreign = <T>(code: string): T => runInNewContext(code) as T;
    const error = () => foreign<Error>('const e = new TypeError("boom token=REALM_SECRET", { cause: new RangeError("inner") }); e');
    const date = () => foreign<Date>("new Date(0)");
    const iso = "1970-01-01T00:00:00.000Z";
    const expectError = (value: unknown) => {
      const shape = value as Record<string, unknown>;
      expect(shape).toMatchObject({ name: "TypeError", message: "boom token=[redacted]", cause: { name: "RangeError", message: "inner" } });
      expect(String(shape.stack)).toContain("TypeError: boom");
    };

    it("the values are foreign, so instanceof cannot see their kind", () => {
      expect(error()).not.toBeInstanceOf(Error);
      expect(date()).not.toBeInstanceOf(Date);
    });

    it("sanitizeValue and redactEvent keep error fields and write dates as ISO text", () => {
      const sanitized = sanitizeValue({ err: error(), at: date() }) as Record<string, Record<string, unknown>>;
      expect(sanitized.err).toMatchObject({ name: "TypeError", message: "boom token=REALM_SECRET", cause: { message: "inner" } });
      expect(sanitized.at).toBe(iso);
      expect(sanitizeValue(date())).toBe(iso);
      const event: LogEvent = { ts: iso, level: "error", msg: "m", name: "n", version: "1", ctx: { err: error(), at: date() } };
      const redacted = redactEvent(event).ctx as Record<string, unknown>;
      expectError(redacted.err);
      expect(redacted.at).toBe(iso);
      expect(JSON.stringify(redacted)).not.toContain("REALM_SECRET");
    });

    it("binary data from another realm is never written byte by byte", () => {
      expect(sanitizeValue({ a: foreign("new ArrayBuffer(4)"), s: foreign("new SharedArrayBuffer(4)"), v: foreign("new Uint8Array([112, 97, 115])") }))
        .toEqual({ a: "[unserializable]", s: "[unserializable]", v: "[unserializable]" });
    });

    it("an object that only claims a kind by tag or prototype stays a record and never throws", () => {
      const claims = { [Symbol.toStringTag]: "Date", token: "x" };
      expect(sanitizeValue(claims)).toEqual({ token: "x" });
      expect(sanitizeValue({ [Symbol.toStringTag]: "ArrayBuffer", n: 1 })).toEqual({ n: 1 });
      expect(sanitizeValue(Object.create(Date.prototype))).toEqual({});
      expect(isValidLogEvent({ ts: iso, level: "info", msg: "m", name: "n", version: "1", ctx: claims })).toBe(true);
    });

    it("sinkHttp body and serverLogger console JSON keep a direct or nested error and date", async () => {
      const spy = fetchSpy();
      const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
      const lines: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));
      for (const logger of [createLogger({ name: "realm", sinks: [sink], pipeline: [redactSecFn()] }), serverLogger({ name: "svc" })]) {
        logger.error("direct error", error() as unknown as Record<string, unknown>);
        logger.error("direct date", date() as unknown as Record<string, unknown>);
        logger.error("nested", { err: error(), at: date() });
      }
      await sink.flush();
      const events = [...spy.events(), ...lines.map((line) => JSON.parse(line) as LogEvent)];
      expect(events).toHaveLength(6);
      for (const [index, event] of events.entries()) {
        const ctx = event.ctx as Record<string, unknown>;
        if (index % 3 === 0) expectError(ctx.error);
        if (index % 3 === 1) expect(ctx).toEqual({ value: iso });
        if (index % 3 === 2) {
          expectError(ctx.err);
          expect(ctx.at).toBe(iso);
        }
      }
      expect([...spy.requests.map((request) => request.body), ...lines].join("\n")).not.toContain("REALM_SECRET");
    });

    it("isValidLogEvent rejects a foreign Error or Date ctx and accepts a foreign plain object", () => {
      const event = (ctx: unknown) => ({ ts: iso, level: "info", msg: "m", name: "n", version: "1", ctx });
      expect(isValidLogEvent(event(error()))).toBe(false);
      expect(isValidLogEvent(event(date()))).toBe(false);
      expect(isValidLogEvent(event(foreign("({ a: 1 })")))).toBe(true);
    });

    describe("Error.isError or the brand fallback decides, so every engine branch agrees", () => {
      const native = Object.getOwnPropertyDescriptor(Error, "isError");
      afterEach(() => {
        if (native) Object.defineProperty(Error, "isError", native);
        else delete (Error as { isError?: unknown }).isError;
      });
      const setIsError = (value: unknown) => Object.defineProperty(Error, "isError", { value, configurable: true, writable: true });
      // Engine branches: no Error.isError (Node < 24), one that reads a DOMException as no error (engines differ:
      // Bun does, Node 22.23+ does not), so the fallback must decide, and the real one where present. The stub
      // models that engine explicitly, whatever this runtime's isNativeError says about a DOMException.
      const slotOnly = (value: unknown) => !(value instanceof DOMException) && isNativeError(value);
      const branches: Array<[string, () => void]> = [
        ["without Error.isError", () => setIsError(undefined)],
        ["with an Error.isError that reads a DOMException as no error", () => setIsError(slotOnly)],
        ...(native ? [["with the native Error.isError", () => Object.defineProperty(Error, "isError", native)] as [string, () => void]] : []),
      ];
      const proxied = () => new Proxy(new Error("proxied"), {});
      // [value, is an error]
      const cases = (): Array<[string, unknown, boolean]> => [
        ["Error", new Error("m"), true],
        ["foreign Error", error(), true],
        ["DOMException", new DOMException("m", "AbortError"), true],
        ["subclass with its own tag", new (class extends Error { get [Symbol.toStringTag]() { return "Mine"; } })("m"), true],
        ["object claiming the Error tag", { [Symbol.toStringTag]: "Error", message: "m", token: "x" }, false],
        ["Object.create(Error.prototype)", Object.create(Error.prototype), false],
        ["proxy of an Error", proxied(), false],
        ["plain object", { message: "m" }, false],
      ];
      const kind = (value: unknown) => {
        const out = sanitizeValue(value) as Record<string, unknown>;
        return typeof out === "object" && out !== null && "name" in out && "message" in out && !("token" in out);
      };

      it("the stub reads a DOMException as no error and a local or foreign Error as one", () => {
        expect([slotOnly(new DOMException("m")), slotOnly(new Error("m")), slotOnly(error()), slotOnly({ message: "m" })]).toEqual([false, true, true, false]);
      });

      it.each(branches.flatMap(([branch]) => cases().map(([name]) => [branch, name])))("%s: %s", (branch, name) => {
        branches.find(([label]) => label === branch)![1]();
        const [, value, expected] = cases().find(([label]) => label === name)!;
        expect(kind(value)).toBe(expected);
        expect(isValidLogEvent({ ts: iso, level: "info", msg: "m", name: "n", version: "1", ctx: value })).toBe(!expected);
      });

      // Everything a DOMException reaches: sanitizeValue, redactEvent, sinkHttp body and serverLogger console JSON.
      const domOutputs = async () => {
        const dom = () => new DOMException("aborted token=DOM_SECRET", "AbortError");
        const controller = new AbortController();
        controller.abort();
        const reason = controller.signal.reason as DOMException;
        const spy = fetchSpy();
        const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
        const lines: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));
        for (const logger of [createLogger({ name: "dom", sinks: [sink], pipeline: [redactSecFn()] }), serverLogger({ name: "svc" })]) {
          logger.error("direct", dom() as unknown as Record<string, unknown>);
          logger.error("nested", { err: dom() });
          logger.error("fetch aborted", reason as unknown as Record<string, unknown>);
        }
        await sink.flush();
        vi.restoreAllMocks();
        const event: LogEvent = { ts: iso, level: "error", msg: "m", name: "n", version: "1", ctx: { err: dom(), reason } };
        const logged = [...spy.events(), ...lines.map((line) => JSON.parse(line) as LogEvent)].map((out) => out.ctx);
        return { sanitized: sanitizeValue({ err: dom() }), redacted: redactEvent(event).ctx, logged, valid: isValidLogEvent({ ...event, ctx: dom() }) };
      };
      const stackless = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/"stack":"(?:[^"\\]|\\.)*"/g, '"stack":"-"'));

      it.each(branches.map(([branch]) => branch))("%s: a DOMException keeps name, message and stack, direct, nested and as an abort reason", async (branch) => {
        branches.find(([label]) => label === branch)![1]();
        const out = await domOutputs();
        const expectDom = (value: unknown, message = "aborted token=[redacted]") => {
          expect(value).toMatchObject({ name: "AbortError", message });
          expect(String((value as { stack?: unknown }).stack)).toContain("AbortError");
        };
        expect(out.sanitized).toMatchObject({ err: { name: "AbortError", message: "aborted token=DOM_SECRET" } });
        expectDom((out.redacted as Record<string, unknown>).err);
        expectDom((out.redacted as Record<string, unknown>).reason, "This operation was aborted");
        expect(out.logged).toHaveLength(6);
        for (const [index, ctx] of out.logged.entries()) {
          const shape = ctx as Record<string, unknown>;
          if (index % 3 === 0) expectDom(shape.error);
          if (index % 3 === 1) expectDom(shape.err);
          if (index % 3 === 2) expectDom(shape.error, "This operation was aborted");
        }
        expect(JSON.stringify([out.redacted, out.logged])).not.toContain("DOM_SECRET");
        expect(out.valid).toBe(false);
      });

      it("every branch writes the same DOMException output", async () => {
        const outputs = [];
        for (const [, select] of branches) {
          select();
          outputs.push(stackless(await domOutputs()));
        }
        for (const output of outputs.slice(1)) expect(output).toEqual(outputs[0]);
      });

      it("a value Error.isError reads as an error is one, at each call", () => {
        const marked = { message: "decided by Error.isError" };
        const isError = vi.fn((value: unknown) => value === marked);
        setIsError(isError);
        expect(sanitizeValue(marked)).toMatchObject({ message: "decided by Error.isError", name: "undefined" });
        expect(sanitizeValue(new Error("m"))).toMatchObject({ name: "Error", message: "m" });
        expect(isError).toHaveBeenCalled();
      });
    });

    it("a foreign error thrown by a sink reaches onError as is", () => {
      const thrown = error();
      const onError = vi.fn();
      createLogger({ name: "realm", onError, sinks: [() => { throw thrown; }] }).info("m");
      expect(onError.mock.calls[0]?.[0]).toBe(thrown);
    });
  });
});
