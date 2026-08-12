import { describe, expect, it } from "vitest";
import { createEditor, Transaction } from "@mdfn/core";
import { createMarkdownProjector } from "@mdfn/markdown";
import { createMdfnStore } from "../src/store";
import { mount, tick, unmount } from "svelte";
import MdfnEditor from "../src/MdfnEditor.svelte";

describe("@mdfn/svelte", () => {
  it("updates and tears down its shared-state store", () => {
    const controller = createEditor({ markdown: "one", projector: createMarkdownProjector() });
    const values: string[] = [];
    const unsubscribe = createMdfnStore(controller).subscribe((snapshot) => values.push(snapshot.markdown));
    controller.dispatch(new Transaction().replaceSource(0, 3, "two").withSource("parity"));
    expect(values).toEqual(["one", "two"]);
    unsubscribe();
    controller.dispatch(new Transaction().replaceSource(0, 3, "end").withSource("cleanup"));
    expect(values).toEqual(["one", "two"]);
  });

  it("mounts the real adapter, replays controller changes, and cleans up", async () => {
    const controller = createEditor({ markdown: "# Mounted", projector: createMarkdownProjector() });
    const target = document.createElement("div");
    document.body.append(target);
    let ready = (): void => {};
    const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
    const component = mount(MdfnEditor, { target, props: { controller, mode: "read-only", editorRef: (handle) => { if (handle) ready(); } } });
    await readyPromise;
    await tick();
    expect(target.querySelector('[data-mdfn-svelte="editor"]')).not.toBeNull();
    controller.dispatch(new Transaction().replaceSource(2, 9, "Changed").withSource("parity"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    expect(target.textContent).toContain("Changed");
    await unmount(component);
    expect(target.children).toHaveLength(0);
  });
});
