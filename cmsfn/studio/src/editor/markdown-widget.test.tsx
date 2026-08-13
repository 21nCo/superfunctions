// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarkdownWidget } from "./widgets/MarkdownWidget";
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

  it("preserves external sidecar data and publishes sidecar-only edits", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const target = document.createElement("div");
    const root = createRoot(target);
    const onChange = vi.fn();
    const profile = { id: "mdfn:gfm", dialect: "gfm" as const, allowRawHtml: false, extensions: [], schemaVersion: 1 };
    const renderValue = async (assetId: string): Promise<void> => {
      await act(async () => root.render(<MarkdownWidget value={{
        type: "text/markdown",
        version: 1,
        markdown: "body",
        profile,
        sidecar: { assets: [{ id: assetId, mediaType: "image/png" }] },
      }} onChange={onChange} />));
    };
    await renderValue("first");
    await renderValue("external");
    const input = target.querySelector<HTMLInputElement>('[aria-label="Comment"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Review");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (Array.from(target.querySelectorAll("button")).find((button) => button.textContent === "Add comment") as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.lastCall?.[0]).toMatchObject({
      markdown: "body",
      sidecar: { assets: [{ id: "external" }], comments: [expect.objectContaining({ resolved: false })] },
    });
    await act(async () => root.unmount());
  });
});
