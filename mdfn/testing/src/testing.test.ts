import { describe, expect, it } from "vitest";
import { deterministicFuzzCorpus, compareSemanticTraces, representativeCorpus, runPreservationCorpus, runSecurityCorpus } from "./index";
import { parseMarkdown, serializeMarkdown } from "@mdfn/markdown";
import { renderHtml } from "@mdfn/render";

describe("@mdfn/testing", () => {
  it("passes the representative no-edit corpus", () => {
    const result = runPreservationCorpus(representativeCorpus);
    expect(result).toMatchObject({ ok: true, failed: 0, passed: representativeCorpus.length });
  });

  it("detects executable render output and adapter divergence", () => {
    const safe = runSecurityCorpus({ type: "doc", schemaVersion: 1, content: [{ type: "opaque", attrs: { syntax: "html" }, text: "<script>bad()</script>" }] });
    expect(safe.ok).toBe(true);
    const reference = { schemaVersion: 1 as const, framework: "vanilla" as const, fixture: "basic", steps: [], finalMarkdown: "a", finalSelection: null, diagnostics: [], cleanup: { subscriptions: 0, mounted: false } };
    const result = compareSemanticTraces(reference, [{ ...reference, framework: "react", finalMarkdown: "b" }]);
    expect(result.ok).toBe(false);
  });

  it("passes a reproducible malformed and Unicode fuzz corpus", () => {
    const corpus = deterministicFuzzCorpus(0x53464e20, 128);
    expect(runPreservationCorpus(corpus)).toMatchObject({ ok: true, passed: 128, failed: 0 });
  });

  it("stays within the documented large-document development budget", () => {
    const source = `${"## Heading\n\nParagraph with **bold**, [link](https://example.com), and 日本語.\n\n".repeat(3_200)}`;
    const started = performance.now();
    const parsed = parseMarkdown(source);
    const serialized = serializeMarkdown({ document: parsed.document, originalSource: source });
    const rendered = renderHtml(parsed.document);
    const elapsed = performance.now() - started;
    expect(source.length).toBeGreaterThan(200_000);
    expect(serialized.markdown).toBe(source);
    expect(rendered.html.length).toBeGreaterThan(100_000);
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);
});
