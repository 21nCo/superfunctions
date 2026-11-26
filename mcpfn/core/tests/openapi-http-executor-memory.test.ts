import { describe, expect, it } from "vitest";
import { fromOpenAPI, httpExecutor } from "../src/openapi/index.js";

// In its own file, so the process's peak resident size starts near its baseline and growth is measurable.
describe("httpExecutor error bodies dense with credential echoes", () => {
  const baseUrl = "http://127.0.0.1:9";
  const { tools } = fromOpenAPI(
    {
      openapi: "3.1.0",
      info: { title: "dense", version: "1.0.0" },
      paths: { "/fail": { get: { operationId: "fail", responses: { "200": { description: "OK" } } } } },
    },
    { executor: httpExecutor({ baseUrl }) },
  );
  // Ordinary one-character values: every operator header value counts as a credential.
  const headers = { "x-api-version": "1", accept: "11", "x-region": "1 1", "x-tier": "2" };

  it.each([
    ["one run of echoes", "1".repeat(1024 * 1024), /^\[REDACTED\]$/],
    ["echoes between spaces", "1 2 ".repeat(256 * 1024), /^(?:\[REDACTED\] ?)+\n\[body truncated after \d+ bytes\]$/],
  ])("redacts a 1 MiB body of %s with memory bounded by a small multiple of the body", async (_label, body, excerpt) => {
    const executor = httpExecutor({
      baseUrl,
      headers,
      fetch: async () => new Response(body, { status: 500, headers: { "content-type": "text/plain" } }),
    });
    const before = process.resourceUsage().maxRSS;
    const result = await executor.execute({
      operation: tools[0]!.operation,
      args: {},
      context: undefined,
      signal: new AbortController().signal,
      hasOutputSchema: false,
    });
    // maxRSS is in KiB.
    const growthMiB = (process.resourceUsage().maxRSS - before) / 1024;
    expect(result.isError).toBe(true);
    const [heading, shown] = (result.content[0] as { text: string }).text.split("\n\n");
    expect(heading).toBe("The API responded with HTTP 500.");
    expect(shown).toMatch(excerpt);
    expect(growthMiB).toBeLessThan(64);
  });
});
