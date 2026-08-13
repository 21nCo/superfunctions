import { describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { createEditor } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import MdfnEditorShell from "../src/MdfnEditorShell.svelte";

describe("Svelte authoring components", () => {
  it("mounts UIFn chrome and every read-only authoring surface", async () => {
    const controller = createEditor({ markdown: "# Outline", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    const component = mount(MdfnEditorShell, { target, props: { controller, mode: "read-only", readOnly: true } });
    await tick();
    expect(target.querySelector('[data-mdfn-component="authoring-chrome"]')).not.toBeNull();
    expect(target.querySelector('[data-mdfn-surface="outline"]')?.textContent).toContain("Outline");
    expect(target.querySelector('[data-uifn-component="card"]')).not.toBeNull();
    await unmount(component);
    expect(target.children).toHaveLength(0);
  });

  it("uses an uncontrolled native file input", async () => {
    const controller = createEditor({ markdown: "# Files", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    const component = mount(MdfnEditorShell, { target, props: { controller, mode: "visual", onSelectFiles: async () => undefined } });
    await tick();
    const input = target.querySelector<HTMLInputElement>('input[type="file"][aria-label="Select files"]');
    expect(input).not.toBeNull();
    expect(input?.hasAttribute("value")).toBe(false);
    expect(input?.dataset.uifnComponent).toBe("input");
    await unmount(component);
  });
});
