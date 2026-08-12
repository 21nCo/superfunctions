import { describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { createEditor } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { MdfnEditorShell } from "./index";

describe("Solid authoring components", () => {
  it("mounts UIFn chrome and every read-only authoring surface", async () => {
    const controller = createEditor({ markdown: "# Outline", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    const dispose = render(() => <MdfnEditorShell controller={controller} mode="read-only" readOnly />, target);
    await Promise.resolve();
    expect(target.querySelector('[data-mdfn-component="authoring-chrome"]')).not.toBeNull();
    expect(target.querySelector('[data-mdfn-surface="outline"]')?.textContent).toContain("Outline");
    expect(target.querySelector('[data-uifn-component="card"]')).not.toBeNull();
    dispose();
    expect(target.children).toHaveLength(0);
  });
});
