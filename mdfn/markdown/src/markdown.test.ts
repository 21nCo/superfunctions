import { describe, expect, it } from "vitest";
import { formatMarkdown, parseMarkdown, serializeMarkdown } from "./index";

describe("@mdfn/markdown", () => {
  const source = "# Hello  \r\n\r\nA **bold** paragraph.\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n<div onclick=\"bad()\">raw</div>\r\n";

  it("provides byte-identical no-edit preservation with GFM and opaque HTML", () => {
    const parsed = parseMarkdown(source);
    const result = serializeMarkdown({ document: parsed.document, originalSource: source });
    expect(result.markdown).toBe(source);
    expect(result.preservation.exactUntouched).toBe(true);
    expect(parsed.document.content.some((node) => node.type === "table")).toBe(true);
    expect(parsed.document.content.some((node) => node.type === "opaque")).toBe(true);
    expect(parsed.diagnostics.some((entry) => entry.code === "MDFN_RAW_HTML_DISABLED")).toBe(true);
  });

  it("normalizes only a dirty top-level region", () => {
    const parsed = parseMarkdown(source);
    const paragraphIndex = parsed.document.content.findIndex((node) => node.type === "paragraph");
    const paragraph = parsed.document.content[paragraphIndex];
    const content = [...(paragraph.content ?? [])];
    content.push({ type: "text", text: " Added." });
    const document = {
      ...parsed.document,
      content: parsed.document.content.map((node, index) => index === paragraphIndex
        ? { ...paragraph, content, source: paragraph.source ? { ...paragraph.source, dirty: true } : undefined }
        : node),
    };
    const result = serializeMarkdown({ document, originalSource: source });
    expect(result.markdown.startsWith("# Hello  \r\n")).toBe(true);
    expect(result.markdown).toContain("Added.");
    expect(result.markdown).toContain("<div onclick=\"bad()\">raw</div>");
    expect(result.preservation.touchedRegionOnly).toBe(true);
  });

  it("enforces resource limits and supports explicit formatting", () => {
    expect(() => parseMarkdown("12345", { maxBytes: 4 })).toThrowError(/MDFN_SOURCE_TOO_LARGE/);
    expect(formatMarkdown("# title\n\ntext").markdown).toContain("# title");
  });

  it("keeps opted-in raw HTML opaque without a disabled-policy diagnostic", () => {
    const parsed = parseMarkdown("<section>safe only after host sanitation</section>\n", { allowRawHtml: true });
    expect(parsed.document.content[0]).toMatchObject({ type: "opaque", attrs: { syntax: "html" } });
    expect(parsed.diagnostics.map((entry) => entry.code)).not.toContain("MDFN_RAW_HTML_DISABLED");
  });

  it("treats lone carriage returns as token boundaries", () => {
    expect(parseMarkdown("one\rtwo\rthree\r", { maxTokenLength: 5 }).lineEnding).toBe("cr");
  });
});
