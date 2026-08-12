// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { createEditor } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { MdfnEditor } from "./index";

describe("@mdfn/react", () => {
  it("binds the shared controller without framework-owned semantics", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const controller = createEditor({ markdown: "# React\n", projector: createMarkdownProjector() });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => { root.render(<MdfnEditor controller={controller} mode="source" />); });
    expect(host.querySelector('[data-mdfn-react="editor"]')).not.toBeNull();
    await act(async () => { root.unmount(); });
  });
});
