import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderField } from "./renderField";

describe("Markdown field widget", () => {
  it("selects the MDFN editor shell for explicit Markdown fields", () => {
    const html = renderToStaticMarkup(renderField(
      { name: "body", type: { kind: "markdown", dialect: "commonmark", allowRawHtml: false, extensions: ["callout"], schemaVersion: 2 } },
      "body",
      "# Heading\n",
      () => {},
    ));
    expect(html).toContain('data-widget="markdown"');
    expect(html).toContain('data-mdfn-component="editor-shell"');
    expect(html).toContain('data-mdfn-react="editor"');
    expect(html).toContain('data-markdown-dialect="commonmark"');
    expect(html).toContain('data-raw-html="false"');
    expect(html).toContain('data-extensions="callout"');
    expect(html).toContain('data-schema-version="2"');
  });

  it("uses the persisted Markdown profile instead of reinterpreting content under schema defaults", () => {
    const html = renderToStaticMarkup(renderField(
      { name: "body", type: { kind: "markdown", dialect: "gfm", allowRawHtml: false, schemaVersion: 1 } },
      "body",
      { type: "text/markdown", version: 1, markdown: "# Historical\n", profile: { id: "mdfn:commonmark", dialect: "commonmark", allowRawHtml: true, extensions: ["callout"], schemaVersion: 2 } },
      () => {},
    ));
    expect(html).toContain('data-markdown-dialect="commonmark"');
    expect(html).toContain('data-raw-html="true"');
    expect(html).toContain('data-schema-version="2"');
    expect(html).toContain('data-extensions="callout"');
  });
});
