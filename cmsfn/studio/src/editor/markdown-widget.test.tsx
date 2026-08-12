import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderField } from "./renderField";

describe("Markdown field widget", () => {
  it("selects the MDFN editor shell for explicit Markdown fields", () => {
    const html = renderToStaticMarkup(renderField(
      { name: "body", type: { kind: "markdown", dialect: "gfm", allowRawHtml: false } },
      "body",
      "# Heading\n",
      () => {},
    ));
    expect(html).toContain('data-widget="markdown"');
    expect(html).toContain('data-mdfn-component="editor-shell"');
    expect(html).toContain('data-mdfn-react="editor"');
  });
});
