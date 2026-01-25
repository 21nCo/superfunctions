import { describe, it, expect } from "vitest";
import { buildAutoSidebar } from "./sidebar";
import { DocPage } from "./types";

describe("buildAutoSidebar", () => {
  it("should create a flat sidebar for root-level pages", () => {
    const pages: DocPage[] = [
      {
        kind: "page",
        id: "intro.md",
        slug: "intro",
        path: "/intro",
        title: "Introduction",
        body: "",
        headings: [],
        frontmatter: {},
      },
      {
        kind: "page",
        id: "getting-started.md",
        slug: "getting-started",
        path: "/getting-started",
        title: "Getting Started",
        body: "",
        headings: [],
        frontmatter: {},
      },
    ];

    const sidebar = buildAutoSidebar(pages);

    expect(sidebar.id).toBe("default");
    expect(sidebar.items).toHaveLength(2);
    expect(sidebar.items[0]).toEqual({
      type: "link",
      text: "Getting Started",
      link: "/getting-started",
    });
    expect(sidebar.items[1]).toEqual({
      type: "link",
      text: "Introduction",
      link: "/intro",
    });
  });

  it("should create nested groups for directory structures", () => {
    const pages: DocPage[] = [
      {
        kind: "page",
        id: "index.md",
        slug: "index",
        path: "/index",
        title: "Home",
        body: "",
        headings: [],
        frontmatter: {},
      },
      {
        kind: "page",
        id: "guides/setup.md",
        slug: "guides/setup",
        path: "/guides/setup",
        title: "Setup Guide",
        body: "",
        headings: [],
        frontmatter: {},
      },
      {
        kind: "page",
        id: "guides/advanced.md",
        slug: "guides/advanced",
        path: "/guides/advanced",
        title: "Advanced Usage",
        body: "",
        headings: [],
        frontmatter: {},
      },
    ];

    const sidebar = buildAutoSidebar(pages);

    expect(sidebar.items).toHaveLength(2);

    // Items are sorted alphabetically by slug, so guides group comes first
    expect(sidebar.items[0].type).toBe("group");
    expect(sidebar.items[0].text).toBe("Guides");
    expect(sidebar.items[0].collapsed).toBe(false);
    expect(sidebar.items[0].items).toHaveLength(2);
    expect(sidebar.items[0].items![0]).toEqual({
      type: "link",
      text: "Advanced Usage",
      link: "/guides/advanced",
    });
    expect(sidebar.items[0].items![1]).toEqual({
      type: "link",
      text: "Setup Guide",
      link: "/guides/setup",
    });

    // Second item should be the index page
    expect(sidebar.items[1]).toEqual({
      type: "link",
      text: "Home",
      link: "/index",
    });
  });

  it("should handle deeply nested directories", () => {
    const pages: DocPage[] = [
      {
        kind: "page",
        id: "api/core/types.md",
        slug: "api/core/types",
        path: "/api/core/types",
        title: "Core Types",
        body: "",
        headings: [],
        frontmatter: {},
      },
      {
        kind: "page",
        id: "api/core/utils.md",
        slug: "api/core/utils",
        path: "/api/core/utils",
        title: "Utilities",
        body: "",
        headings: [],
        frontmatter: {},
      },
      {
        kind: "page",
        id: "api/providers/fs.md",
        slug: "api/providers/fs",
        path: "/api/providers/fs",
        title: "Filesystem Provider",
        body: "",
        headings: [],
        frontmatter: {},
      },
    ];

    const sidebar = buildAutoSidebar(pages);

    expect(sidebar.items).toHaveLength(1);

    // API group
    const apiGroup = sidebar.items[0];
    expect(apiGroup.type).toBe("group");
    expect(apiGroup.text).toBe("Api");
    expect(apiGroup.items).toHaveLength(2);

    // Core subgroup
    const coreGroup = apiGroup.items![0];
    expect(coreGroup.type).toBe("group");
    expect(coreGroup.text).toBe("Core");
    expect(coreGroup.items).toHaveLength(2);

    // Providers subgroup
    const providersGroup = apiGroup.items![1];
    expect(providersGroup.type).toBe("group");
    expect(providersGroup.text).toBe("Providers");
    expect(providersGroup.items).toHaveLength(1);
  });

  it("should sort pages alphabetically within groups", () => {
    const pages: DocPage[] = [
      {
        kind: "page",
        id: "zebra.md",
        slug: "zebra",
        path: "/zebra",
        title: "Zebra",
        body: "",
        headings: [],
        frontmatter: {},
      },
      {
        kind: "page",
        id: "apple.md",
        slug: "apple",
        path: "/apple",
        title: "Apple",
        body: "",
        headings: [],
        frontmatter: {},
      },
      {
        kind: "page",
        id: "banana.md",
        slug: "banana",
        path: "/banana",
        title: "Banana",
        body: "",
        headings: [],
        frontmatter: {},
      },
    ];

    const sidebar = buildAutoSidebar(pages);

    expect(sidebar.items[0].text).toBe("Apple");
    expect(sidebar.items[1].text).toBe("Banana");
    expect(sidebar.items[2].text).toBe("Zebra");
  });

  it("should handle empty pages array", () => {
    const sidebar = buildAutoSidebar([]);

    expect(sidebar.id).toBe("default");
    expect(sidebar.items).toEqual([]);
  });

  it("should capitalize directory names for group labels", () => {
    const pages: DocPage[] = [
      {
        kind: "page",
        id: "testing-utilities/index.md",
        slug: "testing-utilities/index",
        path: "/testing-utilities/index",
        title: "Testing Overview",
        body: "",
        headings: [],
        frontmatter: {},
      },
    ];

    const sidebar = buildAutoSidebar(pages);

    expect(sidebar.items[0].type).toBe("group");
    expect(sidebar.items[0].text).toBe("Testing-utilities"); // Simple title case
  });
});
