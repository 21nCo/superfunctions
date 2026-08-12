import { describe, expect, it } from "vitest";
import { extractChunks, extractHeadings, extractLinks, renderHtml, type RenderPolicy } from "./index";
import type { MdfnDocument } from "@mdfn/core";

const document: MdfnDocument = {
  type: "doc",
  schemaVersion: 1,
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Security" }] },
    { type: "paragraph", content: [
      { type: "text", text: "Open " },
      { type: "link", attrs: { url: "https://example.com" }, content: [{ type: "text", text: "safe" }] },
      { type: "text", text: " or " },
      { type: "link", attrs: { url: "javascript:alert(1)" }, content: [{ type: "text", text: "unsafe" }] },
      { type: "link", attrs: { url: "java\nscript:alert(1)" }, content: [{ type: "text", text: "obfuscated" }] },
      { type: "link", attrs: { url: "\\\\evil.example/path" }, content: [{ type: "text", text: "backslash" }] },
    ] },
    { type: "opaque", attrs: { syntax: "html" }, text: "<img src=x onerror=bad()>" },
  ],
};

describe("@mdfn/render", () => {
  it("escapes raw content and blocks unsafe navigation by default", () => {
    const result = renderHtml(document);
    expect(result.html).toContain('rel="noreferrer noopener"');
    expect(result.html).toContain('data-mdfn-blocked-link="true"');
    expect(result.html).not.toContain("java\nscript");
    expect(result.html).not.toContain("evil.example");
    expect(result.html).toContain("&lt;img src=x onerror=bad()&gt;");
    expect(result.diagnostics.map((entry) => entry.code)).toContain("MDFN_UNSAFE_URL_BLOCKED");
  });

  it("requires a sanitizer before opt-in raw HTML rendering", () => {
    expect(() => renderHtml(document, { rawHtml: { enabled: true } })).toThrowError("MDFN_RAW_HTML_SANITIZER_REQUIRED");
    const policy: RenderPolicy = { rawHtml: { enabled: true, sanitize: () => "<p>sanitized</p>" } };
    expect(renderHtml(document, policy).html).toContain("<p>sanitized</p>");
  });

  it("exposes deterministic search projections", () => {
    expect(extractHeadings(document)[0]).toMatchObject({ level: 2, text: "Security" });
    expect(extractLinks(document)).toHaveLength(4);
    expect(extractChunks(document)[0]).toMatchObject({ heading: "Security" });
  });
});
