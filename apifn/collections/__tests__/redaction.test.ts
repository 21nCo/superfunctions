import { logfnReporter } from "@apifn/core";
import { readFileSync } from "node:fs";
import {
  createConsoleReporter,
  createJsonReporter,
  reportToJUnitXml,
  runCollection,
} from "../src/index.js";
import {
  WITHHELD,
  createCredentialRegistry,
  redactBody,
  redactHeaders,
  redactText,
  redactUrl,
  sanitizeRequestResult,
} from "@apifn/core";
import { createCookieJar, createFetchHttpClient } from "../src/runner/http-client.js";
import type { Collection, CollectionItem, CookieJar, HttpClient, HttpClientResponse, RunReport } from "../src/types.js";

// Fake credentials are assembled at runtime, so no committed literal has a
// detector's shape; the JWT-shaped values give the redactor a realistic form.
const fake = (label: string) => ["test", label, "value"].join("-");
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const jwtShaped = (subject: string) =>
  [b64url(JSON.stringify({ alg: "none", typ: "JWT" })), b64url(JSON.stringify({ sub: subject })), b64url(fake("signature"))].join(".");

const FAKES = {
  accessToken: jwtShaped(fake("access-token")),
  idToken: jwtShaped(fake("id-token")),
  refreshToken: fake("refresh-token"),
  clientSecret: fake("client-secret"),
  code: fake("authorization-code"),
  codeVerifier: fake("code-verifier"),
  queryKey: fake("query-api-key"),
  sessionHeader: fake("session-header"),
  cookie: fake("cookie"),
  urlPassword: fake("url-password"),
  redirectCode: fake("redirect-code"),
  fragmentToken: fake("fragment-token"),
  assertion: fake("client-assertion"),
};

type LogFnClient = Parameters<typeof logfnReporter>[0];

function expectNoFakes(output: string): void {
  for (const [name, value] of Object.entries(FAKES)) {
    expect(output.includes(value), `${name} leaked`).toBe(false);
  }
}

function request(name: string, http: NonNullable<CollectionItem["request"]>["http"], extra: Partial<NonNullable<CollectionItem["request"]>> = {}): CollectionItem {
  return {
    kind: "request",
    name,
    path: `${name}.yml`,
    request: { info: { name, type: "http" }, http, ...extra },
  };
}

function collection(items: CollectionItem[]): Collection {
  return {
    info: { name: "Redaction", type: "collection" },
    rootDir: "/tmp",
    environments: {
      test: {
        name: "test",
        variables: {
          baseUrl: "https://api.example.test",
          queryKey: FAKES.queryKey,
          code: FAKES.code,
          clientSecret: FAKES.clientSecret,
          codeVerifier: FAKES.codeVerifier,
          sessionHeader: FAKES.sessionHeader,
        },
      },
    },
    items,
  };
}

const tokenExchange = request("token-exchange", {
  method: "POST",
  url: "{{baseUrl}}/oauth/token?api_key={{queryKey}}&page=2",
  headers: [
    { name: "Authorization", value: `Basic ${Buffer.from(`client:${FAKES.clientSecret}`).toString("base64")}` },
    { name: "X-Session-Id", value: "{{sessionHeader}}" },
    { name: "Accept", value: "application/json" },
  ],
  body: {
    type: "form",
    data: "grant_type=authorization_code&code={{code}}&client_secret={{clientSecret}}&code_verifier={{codeVerifier}}",
  },
});

function oauthResponse(status: number, body: unknown = {
  access_token: FAKES.accessToken,
  refresh_token: FAKES.refreshToken,
  id_token: FAKES.idToken,
  token_type: "Bearer",
  expires_in: 3600,
}): HttpClientResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      "content-type": "application/json",
      location: `https://app.example.test/callback?code=${FAKES.redirectCode}#access_token=${FAKES.fragmentToken}&state=s`,
      "set-cookie": `sid=${FAKES.cookie}; HttpOnly`,
      "x-refresh-token": FAKES.refreshToken,
    },
    body: text,
    size: Buffer.byteLength(text, "utf8"),
    duration: 1,
    redirects: [
      {
        status: 302,
        url: `https://client:${FAKES.urlPassword}@api.example.test/authorize?client_assertion=${FAKES.assertion}`,
        location: `https://api.example.test/oauth/token?code=${FAKES.redirectCode}`,
        duration: 1,
      },
    ],
  };
}

const testScript = (code: string) => ({ runtime: { scripts: [{ type: "tests" as const, code }] } });

function logCollector() {
  const records: unknown[] = [];
  const logfn = (context: Record<string, unknown> = {}): LogFnClient => ({
    info: (event, payload) => records.push({ context, event, payload }),
    warn: (event, payload) => records.push({ context, event, payload }),
    debug: (event, payload) => records.push({ context, event, payload }),
    error: (event, error, payload) => records.push({ context, event, error: String(error), payload }),
    child: (next) => logfn({ ...context, ...next }),
  });
  return { records, reporter: logfnReporter(logfn()) };
}

/** Every reporter output of a run: the returned report, JSON, failed JUnit and LogFn. */
async function runAndReport(items: CollectionItem[], options: Parameters<typeof runCollection>[1]) {
  const json: string[] = [];
  const logs = logCollector();
  const jsonReporter = createJsonReporter({ write: (text) => json.push(text) });
  const report = await runCollection(collection(items), {
    ...options,
    reporter: {
      onRequestComplete: (result) => logs.reporter.onRequestComplete?.(result),
      onComplete: (completed) => jsonReporter.onComplete?.(completed),
    },
  });
  const outputs = { report: JSON.stringify(report), json: json.join(""), junit: reportToJUnitXml(report), logfn: JSON.stringify(logs.records) };
  return { report, outputs, all: Object.values(outputs).join("\n") };
}

describe("report redaction", () => {
  it("JSON reporter output and the returned report carry no URL, redirect, header or OAuth body credentials", async () => {
    const written: string[] = [];
    const httpClient: HttpClient = { send: async () => oauthResponse(200) };

    const report = await runCollection(collection([tokenExchange]), {
      environment: "test",
      httpClient,
      reporter: createJsonReporter({ write: (text) => written.push(text) }),
    });

    expectNoFakes(written.join(""));
    expectNoFakes(JSON.stringify(report));
    const result = report.results[0]!;
    expect(result.status).toBe("passed");
    expect(result.url).toBe("https://api.example.test/oauth/token?api_key=[REDACTED]&page=2");
    expect(result.request.headers).toEqual({ Authorization: "[REDACTED]", "X-Session-Id": "[REDACTED]", Accept: "application/json" });
    expect(result.request.body).toBe("grant_type=authorization_code&code=[REDACTED]&client_secret=[REDACTED]&code_verifier=[REDACTED]");
    expect(result.response?.headers.location).toBe("https://app.example.test/callback?code=[REDACTED]#access_token=[REDACTED]&state=[REDACTED]");
    expect(result.response?.headers["set-cookie"]).toBe("sid=[REDACTED]; HttpOnly");
    expect(result.response?.redirects?.[0]).toMatchObject({
      url: "https://api.example.test/authorize?client_assertion=[REDACTED]",
      location: "https://api.example.test/oauth/token?code=[REDACTED]",
    });
    expect(JSON.parse(result.response!.body)).toEqual({
      access_token: "[REDACTED]",
      refresh_token: "[REDACTED]",
      id_token: "[REDACTED]",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  it("failed JUnit output redacts retried attempts, failures and errors", async () => {
    const unreachable = request("unreachable", { method: "GET", url: "{{baseUrl}}/me?access_token={{queryKey}}" });
    const sends = new Map<string, number>();
    const httpClient: HttpClient = {
      async send(req) {
        const count = (sends.get(req.url) ?? 0) + 1;
        sends.set(req.url, count);
        if (req.url.includes("/me")) throw new Error(`connect ECONNREFUSED ${req.url} with Authorization: Bearer ${FAKES.accessToken}`);
        if (count === 1) throw new Error(`socket hang up for ${req.url}`);
        if (count === 2) return oauthResponse(503);
        return oauthResponse(400, { error: "invalid_grant", detail: `rejected ${FAKES.refreshToken}`, assertion: FAKES.assertion });
      },
    };

    const report = await runCollection(collection([tokenExchange, unreachable]), { environment: "test", retries: 2, httpClient });
    const xml = reportToJUnitXml(report);

    expectNoFakes(xml);
    expectNoFakes(JSON.stringify(report));
    expect(xml).toContain("<failure ");
    expect(xml).toContain("<error ");
    const [failed, errored] = report.results;
    expect(failed?.attempts?.map((attempt) => attempt.error ?? attempt.statusCode)).toEqual([
      "socket hang up for https://api.example.test/oauth/token?api_key=[REDACTED]",
      503,
      400,
    ]);
    // The refresh token came in the retried 503 response; its echo in the final 400 body is scrubbed.
    expect(JSON.parse(failed!.response!.body)).toEqual({ error: "invalid_grant", detail: "rejected [REDACTED]", assertion: "[REDACTED]" });
    expect(errored?.attempts).toHaveLength(3);
    // The keyword rule redacts from a credential key to the end of its line.
    expect(errored?.error).toBe("connect ECONNREFUSED https://api.example.test/me?access_token=[REDACTED]");
  });

  it("redacts a response body before truncating it", async () => {
    const maxCapturedBodyBytes = 10 * 1024 * 1024;
    const oversized = request("oversized", { method: "GET", url: "{{baseUrl}}/large" });
    const cutShort = request("cut-short", { method: "GET", url: "{{baseUrl}}/cut" });
    const httpClient: HttpClient = {
      async send(req) {
        if (req.url.endsWith("/large")) {
          // Valid JSON over the capture limit: cutting it first would leave text no JSON parser accepts.
          return oauthResponse(200, { access_token: FAKES.accessToken, padding: "x".repeat(maxCapturedBodyBytes + 1024), refresh_token: FAKES.refreshToken });
        }
        // A body the server itself cut inside a credential member.
        return oauthResponse(200, `{"token_type":"Bearer","refresh_token":"${FAKES.refreshToken}`);
      },
    };

    const { report, all } = await runAndReport([oversized, cutShort], { environment: "test", httpClient });

    const byName = (name: string) => report.results.find((result) => result.name === name);
    const largeBody = byName("oversized")?.response?.body ?? "";
    expect(Buffer.byteLength(largeBody, "utf8")).toBeLessThanOrEqual(maxCapturedBodyBytes);
    expect(largeBody.startsWith('{\n  "access_token": "[REDACTED]",\n  "padding": "xxx')).toBe(true);
    expect(byName("cut-short")?.response?.body).toBe('{"token_type":[REDACTED]');
    expectNoFakes(all);
  });

  it("LogFn and console output from a failed run carry no credentials", async () => {
    const asserted = request(
      "asserted",
      { method: "GET", url: "{{baseUrl}}/userinfo?code={{code}}" },
      testScript(`test("body matches", function() { expect(res.body).to.equal({ token_type: "Bearer" }); });`)
    );
    const consoleOutput: string[] = [];
    const consoleReporter = createConsoleReporter({ color: false, write: (text) => consoleOutput.push(text) });
    const logs = logCollector();

    const report: RunReport = await runCollection(collection([asserted]), {
      environment: "test",
      allowScripts: true,
      retries: 1,
      httpClient: { send: async () => oauthResponse(200) },
      reporter: {
        onRequestComplete: (result) => {
          logs.reporter.onRequestComplete?.(result);
          consoleReporter.onRequestComplete?.(result);
        },
      },
    });

    expect(report.results[0]?.status).toBe("failed");
    const logged = JSON.stringify(logs.records);
    expectNoFakes(logged);
    expectNoFakes(consoleOutput.join(""));
    expect(logged).toContain("https://api.example.test/userinfo?code=[REDACTED]");
    expect(report.results[0]?.assertions[0]?.actual).toEqual({
      access_token: "[REDACTED]",
      refresh_token: "[REDACTED]",
      id_token: "[REDACTED]",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  it("LogFn sanitizes a raw result passed to it directly", () => {
    const logs = logCollector();
    const raw = {
      name: `refresh_token=${FAKES.refreshToken}`,
      path: "raw.yml",
      method: "POST",
      url: `https://client:${FAKES.urlPassword}@api.example.test/token?code=${FAKES.code}`,
      status: "failed" as const,
      duration: 1,
      assertions: [{ name: "token", passed: false, expected: "x", actual: FAKES.accessToken, error: `expected '${FAKES.accessToken}' to equal 'x'` }],
      request: { method: "POST", url: "https://api.example.test/token", headers: { authorization: `Bearer ${FAKES.accessToken}` } },
      response: { status: 200, headers: {}, body: JSON.stringify({ access_token: FAKES.accessToken }), size: 1 },
    };

    logs.reporter.onRequestStart?.({ name: raw.name, path: raw.path });
    logs.reporter.onRequestComplete?.(raw);

    const logged = JSON.stringify(logs.records);
    expectNoFakes(logged);
    expect(logged).toContain("https://api.example.test/token?code=[REDACTED]");
    expect(logged).toContain("expected '[REDACTED]' to equal 'x'");
  });
});

describe("shared credential vectors", () => {
  const vectors = JSON.parse(readFileSync(new URL("./fixtures/redaction-vectors.json", import.meta.url), "utf8"));
  const value = fake("vector");
  const fill = (template: string) =>
    Object.entries(vectors.fill as Record<string, string>).reduce((text, [placeholder, with_]) => text.split(placeholder).join(with_), template.split(vectors.placeholder).join(value));

  it("redacts every shape from review rounds 1-6, and redacting twice changes nothing more", () => {
    for (const shape of vectors.shapes as string[]) {
      const once = redactText(fill(shape));
      expect(once.includes(value), shape).toBe(false);
      expect(redactText(once), shape).toBe(once);
    }
    for (const { text, redactHeaders: names } of vectors.configured as Array<{ text: string; redactHeaders: string[] }>) {
      const once = redactText(fill(text), { redactHeaders: names });
      expect(once.includes(value), text).toBe(false);
      expect(redactText(once, { redactHeaders: names }), text).toBe(once);
    }
  });

  it("never lets a credential value survive any benign prefix or suffix, and is idempotent", () => {
    const { prefixes, forms, suffixes } = vectors.combinations as Record<string, string[]>;
    const failures: string[] = [];
    for (const prefix of prefixes) {
      for (const form of forms) {
        for (const suffix of suffixes) {
          const text = prefix + fill(form) + suffix;
          const once = redactText(text);
          if (once.includes(value) || redactText(once) !== once) failures.push(text);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("removes userinfo wherever a URL parser reads it, and keeps every reference it reads without credentials", () => {
    const urls = vectors.urls;
    const computed: number[][] = [];
    const leaks: string[] = [];
    const changed: string[] = [];
    urls.schemes.forEach((scheme: string, a: number) =>
      urls.separators.forEach((separator: string, b: number) =>
        urls.userinfo.forEach((info: string, c: number) =>
          urls.hosts.forEach((host: string, d: number) => {
            const ref = fill(`${scheme}${separator}${info}{AT}${host}`);
            const parsed = (() => {
              try {
                return new URL(ref, urls.base);
              } catch {
                return undefined;
              }
            })();
            const redacted = redactUrl(ref, { base: urls.base });
            if (parsed && (parsed.username || parsed.password)) {
              computed.push([a, b, c, d]);
              const after = new URL(redacted, urls.base);
              if (after.username || after.password || redacted.includes(value)) leaks.push(`url ${JSON.stringify(ref)}`);
              if (redactHeaders({ location: ref }, { base: urls.base }).location.includes(value)) leaks.push(`location ${JSON.stringify(ref)}`);
              if (redactText(`see ${ref} now`).includes(value)) leaks.push(`text ${JSON.stringify(ref)}`);
            } else if (redacted !== ref) {
              changed.push(JSON.stringify(ref));
            }
          })
        )
      )
    );
    expect(computed).toEqual(urls.userinfoRefs);
    expect(leaks).toEqual([]);
    expect(changed).toEqual([]);
    for (const kept of urls.kept as string[]) expect(redactUrl(fill(kept), { base: urls.base })).toBe(fill(kept));
  });

  it("removes credential query and fragment parameters by key and keeps every other parameter", () => {
    const base = "https://app.example.test/";
    const refs = [
      `/cb?code=${value}&status=completed`,
      `//h.example.test/cb?x=1#access_token=${value}&state=s`,
      `https://h.example.test/cb?user%5Bpassword%5D=${value}&page=2`,
      `?refresh_t%6Fken=${value}`,
      `\t/cb?client_secret=${value}`,
    ];
    for (const ref of refs) {
      const redacted = new URL(redactUrl(ref, { base }), base);
      expect(redacted.href.includes(value), ref).toBe(false);
      expect([...redacted.searchParams.values(), redacted.hash].join(" "), ref).not.toContain(value);
    }
    expect(redactUrl(`/cb?code=${value}&status=completed`, { base })).toBe("https://app.example.test/cb?code=[REDACTED]&status=completed");
    expect(redactUrl("/team@east/callback?status=completed", { base })).toBe("/team@east/callback?status=completed");
    expect(redactHeaders({ cookie: "region=us; sid=abc" })).toEqual({ cookie: "region=[REDACTED]; sid=[REDACTED]" });
  });

  it("redacts r6 shapes: a URL line before a header line, multi-name objects, namespaced XML", () => {
    const shapes = [
      `GET https://api.example.test/items?page=1\nX-Api-Key: ${value}`,
      `{"name":"X-Api-Key","param":"header","value":"${value}"}`,
      `{"value":"${value}","param":"header","name":"X-Api-Key"}`,
      `rejected {"key":"X-Api-Key","name":"display","value":"${value}"}`,
      `<wsse:Password Type="PasswordText">${value}</wsse:Password>`,
      `--b\r\nContent-Disposition: form-data; name="password"\r\n\r\n--b-${value}\r\n--b--`,
    ];
    for (const shape of shapes) expect(redactText(shape).includes(value), shape).toBe(false);
    expect(redactText(`GET https://api.example.test/items?page=1\nX-Api-Key: ${value}`)).toBe("GET https://api.example.test/items?page=1\nX-Api-Key: [REDACTED]");
  });
});

describe("structured bodies", () => {
  it("redacts name/value objects and [name, value] pairs in parsed JSON in any member order, and nothing else", () => {
    const body = JSON.stringify({
      headers: [{ value: FAKES.sessionHeader, meta: { note: "a}b" }, name: "X-Api-Key" }, { name: "Accept", value: "text/plain" }],
      params: [["client_secret", FAKES.clientSecret], ["page", "2"]],
      usage: { total_tokens: 1234 },
      state: "completed",
    });
    expect(JSON.parse(redactBody(body)!)).toEqual({
      headers: [{ value: "[REDACTED]", meta: { note: "a}b" }, name: "X-Api-Key" }, { name: "Accept", value: "text/plain" }],
      params: [["client_secret", "[REDACTED]"], ["page", "2"]],
      usage: { total_tokens: 1234 },
      state: "completed",
    });
  });

  it("walks JSON nested deeper than the call stack without throwing", () => {
    const nested = (depth: number, inner: string) => "[".repeat(depth) + inner + "]".repeat(depth);
    const redacted = redactBody(`{"data":${nested(12_000, `{"access_token":"${FAKES.accessToken}"}`)},"refresh_token":"${FAKES.refreshToken}"}`) ?? "";
    expect(redacted).toContain("[REDACTED: nesting too deep]");
    expectNoFakes(redacted);
  });

  it("scrubs known values detached from their keys, numbers and escaped forms included, without scrubbing literals or counts", () => {
    const registry = createCredentialRegistry();
    registry.collectResponse({ body: JSON.stringify({ otp: 135791, access_token: `a"${FAKES.accessToken}`, enabled: true, max_tokens: 4096, note: null }) });
    const result = sanitizeRequestResult(
      {
        name: "n",
        status: "failed",
        assertions: [
          { name: "otp", passed: false, expected: 0, actual: 135791, error: "expected 135791 to equal 0" },
          { name: "flag", passed: false, expected: true, actual: false, error: "expected false to be true; max 4096" },
        ],
        error: `echo ${JSON.stringify(`a"${FAKES.accessToken}`)}`,
      },
      { registry }
    );
    expect(result.assertions).toEqual([
      { name: "otp", passed: false, expected: 0, actual: "[REDACTED]", error: "expected [REDACTED] to equal 0" },
      { name: "flag", passed: false, expected: true, actual: false, error: "expected false to be true; max 4096" },
    ]);
    expectNoFakes(result.error);
  });
});

describe("runner capture and the run registry", () => {
  const echoing = (respond: (req: Request) => Response | Promise<Response>): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => respond(new Request(input, init))) as typeof fetch;

  it("asks a rotating cookie jar once per send and scrubs the cookie it sent from a later failed result", async () => {
    let lookups = 0;
    const jar: CookieJar = {
      ...createCookieJar(),
      getCookieHeader: () => {
        lookups += 1;
        return `sid=${fake(`rotating-session-${lookups}`)}`;
      },
    };
    const httpClient = createFetchHttpClient({
      cookieJar: jar,
      fetchImpl: echoing((req) =>
        req.url.endsWith("/second")
          ? new Response(JSON.stringify({ error: `stale ${req.headers.get("cookie")}`, earlier: fake("rotating-session-1") }), { status: 401 })
          : new Response("{}", { status: 200 })
      ),
    });
    const items = [request("first", { method: "GET", url: "{{baseUrl}}/first" }), request("second", { method: "GET", url: "{{baseUrl}}/second" })];

    const { report, all } = await runAndReport(items, { environment: "test", httpClient, cookieJar: jar });

    expect(lookups).toBe(2);
    expect(report.results.map((result) => result.request.headers.cookie)).toEqual(["sid=[REDACTED]", "sid=[REDACTED]"]);
    expect(all).not.toContain("rotating-session");
  });

  it("passes a 200 whose redirects cannot be read with one send, withholding only the report body", async () => {
    let sends = 0;
    const httpClient: HttpClient = {
      async send() {
        sends += 1;
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, echo: FAKES.code }),
          size: 10,
          duration: 1,
          get redirects(): never {
            throw new Error(`redirect log unavailable for ${FAKES.redirectCode}`);
          },
        };
      },
    };
    const item = request("unreadable", { method: "GET", url: "{{baseUrl}}/x" }, testScript(`test("ok", function() { expect(res.status).to.equal(200); expect(res.body.ok).to.equal(true); });`));

    const { report, all } = await runAndReport([item], { environment: "test", retries: 2, allowScripts: true, httpClient });

    expect(sends).toBe(1);
    expect(report.results[0]).toMatchObject({ status: "passed", attempts: [{ attempt: 1, statusCode: 200 }], response: { body: WITHHELD } });
    expect(report.results[0]?.warnings).toContain("Response redirects could not be read; the response body is withheld from the report.");
    expectNoFakes(all);
  });

  it("records an invalid status or a non-string body as a failed attempt, retried, without rejecting the run", async () => {
    const replies = [{ status: Number.NaN, body: "x" }, { status: 200, body: 42 }, { status: 200, body: "{}" }];
    let sends = 0;
    const httpClient = { send: async () => ({ headers: {}, size: 1, duration: 1, ...replies[sends++] }) } as unknown as HttpClient;
    const report = await runCollection(collection([request("flaky", { method: "GET", url: "{{baseUrl}}/x" })]), { environment: "test", retries: 2, httpClient });
    expect(sends).toBe(3);
    expect(report.results[0]?.attempts?.map((attempt) => attempt.error ?? attempt.statusCode)).toEqual([
      "HTTP client returned an invalid status code",
      "HTTP client returned a response body that is not a string",
      200,
    ]);
  });

  it("does not resend a request when a reporter throws", async () => {
    let sends = 0;
    const promise = runCollection(collection([tokenExchange]), {
      environment: "test",
      retries: 2,
      httpClient: { send: async () => ((sends += 1), oauthResponse(200)) },
      reporter: {
        onRequestComplete() {
          throw new Error("reporter failed");
        },
      },
    });
    await expect(promise).rejects.toThrow("reporter failed");
    expect(sends).toBe(1);
  });

  it("keeps each run's registry to itself when two runs share one client", async () => {
    const own = { a: fake("run-a-key"), b: fake("run-b-key") };
    const httpClient = createFetchHttpClient({
      fetchImpl: echoing(async (req) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        // Each server reply echoes the key the request sent and mentions the other run's key as plain data.
        const sentKey = req.headers.get("x-api-key") ?? "";
        const other = sentKey === own.a ? own.b : own.a;
        return new Response(JSON.stringify({ error: `bad key ${sentKey}`, other }), { status: 401 });
      }),
    });
    const item = request("keyed", { method: "GET", url: "{{baseUrl}}/k", headers: [{ name: "X-Api-Key", value: "{{apiKey}}" }] });
    const run = (apiKey: string) =>
      runCollection({ ...collection([item]), environments: { test: { name: "test", variables: { baseUrl: "https://api.example.test", apiKey } } } }, { environment: "test", httpClient });

    const [a, b] = await Promise.all([run(own.a), run(own.b)]);

    expect(JSON.parse(a.results[0]!.response!.body)).toEqual({ error: "bad key [REDACTED]", other: own.b });
    expect(JSON.parse(b.results[0]!.response!.body)).toEqual({ error: "bad key [REDACTED]", other: own.a });
  });

  it("scrubs a credential variable a script rotated from later results in every reporter", async () => {
    const rotated = fake("rotated-access-token");
    const rotate = request("1-rotate", { method: "GET", url: "{{baseUrl}}/rotate" }, testScript(`env.set("access_token", ${JSON.stringify(rotated)});`));
    const later = request(
      "2-later",
      { method: "GET", url: "{{baseUrl}}/later" },
      testScript(`test("echo", function() { expect(res.body.seen).to.equal("other"); });`)
    );
    const httpClient: HttpClient = {
      send: async (req) => {
        const body = JSON.stringify({ seen: req.url.endsWith("/later") ? rotated : "none" });
        return { status: 200, headers: {}, body, size: body.length, duration: 1 };
      },
    };

    const { report, all } = await runAndReport([rotate, later], { environment: "test", allowScripts: true, httpClient });

    expect(report.results[1]?.status).toBe("failed");
    expect(report.results[1]?.assertions[0]).toMatchObject({ actual: "[REDACTED]" });
    expect(all).not.toContain(rotated);
  });
});

describe("redaction work stays bounded", () => {
  const elapsed = (work: () => unknown) => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      work();
      best = Math.min(best, performance.now() - started);
    }
    return Math.max(best, 5);
  };
  // 4x the input may cost about 4x the time (8x allowed for noise), never 16x.
  const linear = (label: string, run: (scale: number) => unknown) => expect(elapsed(() => run(4)) / elapsed(() => run(1)), label).toBeLessThan(8);

  it("keeps each Layer 2 pass linear on hostile text", () => {
    const keywordShapes = ["token=a ", 'name="X-Api-Key"\n', '{"name":"X-Api-Key","a":', "password: {\"a\": [", "(x-api-key ", "\\u0022access_token\\u0022:", "<password a=b "];
    for (const shape of keywordShapes) linear(shape, (scale) => redactText(shape.repeat(Math.floor((50_000 * scale) / shape.length))));
    const urlShapes = ["https://a b", "//u:p@h ", "x:y?z ", "https://a\t"];
    for (const shape of urlShapes) linear(shape, (scale) => redactText(shape.repeat(Math.floor((50_000 * scale) / shape.length))));
    const registry = createCredentialRegistry();
    for (let index = 0; index < 2000; index += 1) registry.add(`credentialvalue${index}`);
    linear("registry", (scale) => registry.scrub("credentialvalu".repeat(20_000 * scale)));
    expect(registry.scrub("see credentialvalue42 here")).toBe("see [REDACTED] here");
  });

  it("scrubs against many values sharing long prefixes without withholding a large body", () => {
    const padded = (subject: string) =>
      [b64url(JSON.stringify({ alg: "none", typ: "JWT" })), b64url(JSON.stringify({ sub: subject, pad: "x".repeat(300) })), b64url(fake("signature"))].join(".");
    const registry = createCredentialRegistry();
    for (let index = 0; index < 1000; index += 1) registry.add(padded(fake(`registry-subject-${index}`)));
    const body = JSON.stringify({ items: Array.from({ length: 2000 }, (_, index) => ({ id: index, note: padded(`listed-${index}`) })) });
    const result = sanitizeRequestResult({ name: "n", response: { status: 200, headers: { "x-trace": "kept" }, body } }, { registry });
    expect(result.response.headers).toEqual({ "x-trace": "kept" });
    expect(JSON.parse(result.response.body).items).toHaveLength(2000);
  });
});
