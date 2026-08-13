import { describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { createEditor, Transaction } from "@mdfn/core";
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

  it("keeps shell-only properties off the editor DOM", async () => {
    const controller = createEditor({ markdown: "# Props", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    const dispose = render(() => <MdfnEditorShell controller={controller} mode="read-only" readOnly class="shell-class" actor={{ id: "author" }} onModeChange={() => {}} onSelectFiles={async () => undefined} />, target);
    await Promise.resolve();
    const shell = target.querySelector('[data-mdfn-component="editor-shell"]');
    const editor = target.querySelector('[data-mdfn-solid="editor"]');
    expect(shell?.classList.contains("shell-class")).toBe(true);
    expect(editor?.hasAttribute("actor")).toBe(false);
    expect(editor?.hasAttribute("onModeChange")).toBe(false);
    expect(editor?.hasAttribute("onSelectFiles")).toBe(false);
    dispose();
  });

  it("keeps toolbar parts mounted when the editor and document become reactive", async () => {
    const controller = createEditor({ markdown: "# Reactive", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    const dispose = render(() => <MdfnEditorShell controller={controller} mode="visual" />, target);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(target.querySelector('[data-mdfn-source-fallback="true"]')).toBeNull();
    expect(target.querySelector('[data-mdfn-editor="visual"]')).not.toBeNull();
    controller.dispatch(new Transaction().replaceSource(0, 0, "Updated "));
    await Promise.resolve();
    expect(target.querySelector('[data-mdfn-source-fallback="true"]')).toBeNull();
    dispose();
  });
});
