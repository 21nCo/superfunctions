// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createEditor, Transaction } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { MdfnAuthoringChrome, MdfnEditorShell, MdfnToolbar } from "./index";

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

  it("keeps the visual editor mounted after publishing its command target", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const controller = createEditor({ markdown: "# Mounted", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    const root = createRoot(target);
    let ready = (): void => {};
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    await act(async () => {
      root.render(<MdfnEditorShell controller={controller} mode="visual" onSelectFiles={async () => undefined} onReady={ready} />);
    });
    await act(async () => { await readyPromise; });
    expect(target.querySelector('[data-mdfn-editor="visual"]')).not.toBeNull();
    await act(async () => { controller.dispatch(new Transaction().replaceSource(0, 0, "Updated ")); });
    expect(target.querySelector('[data-mdfn-editor="visual"]')).not.toBeNull();
    await act(async () => root.unmount());
  });
});
