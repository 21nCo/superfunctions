import { describe, expect, it } from "vitest";
import { isMarkdownContent, markdownContent, migrateToMarkdownContent } from "./index";
describe("markdown content", () => {
  it("is explicit and persists its parsing profile", () => {
    const content = markdownContent("# x");
    expect(isMarkdownContent(content)).toBe(true);
    expect(content).toMatchObject({ version: 1, profile: { dialect: "gfm", allowRawHtml: false, schemaVersion: 1 } });
  });
  it("migrates strings exactly and reports lossy rich-text blocks", () => {
    expect(migrateToMarkdownContent("# exact")).toMatchObject({ content: { markdown: "# exact" }, lossy: false });
    const result = migrateToMarkdownContent([{ type: "widget", value: 1 }]);
    expect(result.lossy).toBe(true);
    expect(result.content.markdown).toContain("mdfn-migration-opaque");
  });
  it("keeps unsupported migration payloads inert and handles non-JSON values", () => {
    const circular: Record<string, unknown> = { type: "widget", value: "--> <script>alert(1)</script>" };
    circular.self = circular;
    const result = migrateToMarkdownContent([circular, 1n]);
    expect(result.lossy).toBe(true);
    expect(result.content.markdown).not.toContain("<script>");
    expect(result.content.markdown).not.toContain("--> <");
    expect(result.content.markdown.match(/mdfn-migration-opaque/g)).toHaveLength(2);
  });
});
