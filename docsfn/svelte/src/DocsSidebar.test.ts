import { cleanup, render } from "@testing-library/svelte";
import type { Sidebar } from "@docsfn/core/browser";
import { afterEach, describe, expect, it } from "vitest";
import DocsSidebar from "./DocsSidebar.svelte";

const sidebar: Sidebar = {
  id: "docs",
  items: [
    {
      type: "group",
      text: "Getting Started",
      items: [{ type: "link", text: "Installation", link: "/docs/installation" }],
    },
    {
      type: "group",
      text: "Core Concepts",
      items: [{ type: "link", text: "Configuration", link: "/docs/configuration" }],
    },
  ],
};

afterEach(() => {
  cleanup();
});

describe("DocsSidebar", () => {
  it("keeps the previous section open when navigation activates another section", async () => {
    const view = render(DocsSidebar, {
      sidebar,
      activePath: "/docs/installation",
    });

    let groups = Array.from(document.querySelectorAll<HTMLDetailsElement>("details"));
    expect(groups[0]?.open).toBe(true);
    expect(groups[1]?.open).toBe(false);

    await view.rerender({ sidebar, activePath: "/docs/configuration" });

    groups = Array.from(document.querySelectorAll<HTMLDetailsElement>("details"));
    expect(groups[0]?.open).toBe(true);
    expect(groups[1]?.open).toBe(true);
  });
});
