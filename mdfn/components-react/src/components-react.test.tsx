import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createEditor } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { MdfnAuthoringChrome, MdfnToolbar } from "./index";

describe("React toolbar", () => {
  it("renders UIFn-owned chrome", () => {
    const controller = createEditor({ markdown: "# hi", projector: createMarkdownProjector() });
    const html = renderToStaticMarkup(<MdfnToolbar controller={controller} />);
    expect(html).toContain("data-uifn-component=\"toolbar\"");
    expect(html).toContain("data-mdfn-component=\"toolbar\"");
  });

  it("renders the complete responsive authoring surface with UIFn chrome", () => {
    const controller = createEditor({ markdown: "# Outline", projector: createMarkdownProjector() });
    const html = renderToStaticMarkup(<MdfnAuthoringChrome controller={controller} mode="read-only" readOnly />);
    expect(html).toContain('data-mdfn-component="authoring-chrome"');
    expect(html).toContain('data-mdfn-surface="outline"');
    expect(html).toContain('data-mdfn-surface="diagnostics"');
    expect(html).toContain('data-mdfn-surface="editorial"');
    expect(html).toContain('data-mdfn-surface="history"');
    expect(html).toContain('data-uifn-component="card"');
  });
});
