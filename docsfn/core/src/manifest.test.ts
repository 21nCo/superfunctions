import { describe, it, expect } from "vitest";
import { buildManifest } from "./manifest";
import {
  MockContentProvider,
  createMockDocEntry,
  createMockPostEntry,
  createMockApiEntry,
  assertValidDocPage,
  assertValidBlogPost,
  assertValidApiReference,
} from "./test-utils";

describe("buildManifest", () => {
  const basicConfig = {
    site: {
      title: "Test Docs",
      description: "Test documentation site",
    },
  };

  it("should build a manifest from doc pages", async () => {
    const provider = new MockContentProvider([
      createMockDocEntry(),
      createMockDocEntry({
        id: "guide.md",
        frontmatter: { title: "Guide", slug: "guide" },
      }),
    ]);

    const manifest = await buildManifest(provider, basicConfig);

    expect(manifest.site).toEqual(basicConfig.site);
    expect(Object.keys(manifest.pages)).toHaveLength(2);
    expect(Object.keys(manifest.posts)).toHaveLength(0);
    expect(Object.keys(manifest.apis)).toHaveLength(0);

    const testDoc = manifest.pages["test-doc.md"];
    assertValidDocPage(testDoc);
    expect(testDoc.title).toBe("Test Document");
    expect(testDoc.headings).toHaveLength(2); // # Test Doc, ## Section 1
  });

  it("should build a manifest from blog posts", async () => {
    const provider = new MockContentProvider([
      createMockPostEntry(),
      createMockPostEntry({
        id: "another-post.md",
        frontmatter: {
          title: "Another Post",
          date: "2026-01-17",
          tags: ["news"],
        },
      }),
    ]);

    const manifest = await buildManifest(provider, basicConfig);

    expect(Object.keys(manifest.posts)).toHaveLength(2);

    const testPost = manifest.posts["test-post.md"];
    assertValidBlogPost(testPost);
    expect(testPost.title).toBe("Test Post");
    expect(testPost.date).toBe("2026-01-18");
    expect(testPost.tags).toEqual(["testing", "docs"]);
    expect(testPost.path).toBe("/blog/test-post");
  });

  it("should build a manifest from API references", async () => {
    const provider = new MockContentProvider([createMockApiEntry()]);

    const manifest = await buildManifest(provider, basicConfig);

    expect(Object.keys(manifest.apis)).toHaveLength(1);

    const testApi = manifest.apis["test-api.json"];
    assertValidApiReference(testApi);
    expect(testApi.title).toBe("Test API Reference");
    expect(testApi.path).toBe("/api/test-api");
    expect(testApi.spec).toHaveProperty("openapi");
    expect(testApi.spec.openapi).toBe("3.0.0");
  });

  it("should generate routes mapping for all content", async () => {
    const provider = new MockContentProvider([
      createMockDocEntry(),
      createMockPostEntry(),
      createMockApiEntry(),
    ]);

    const manifest = await buildManifest(provider, basicConfig);

    expect(manifest.routes["/test-doc"]).toBe("test-doc.md");
    expect(manifest.routes["/blog/test-post"]).toBe("test-post.md");
    expect(manifest.routes["/api/test-api"]).toBe("test-api.json");
  });

  it("should auto-generate default sidebar from pages", async () => {
    const provider = new MockContentProvider([
      createMockDocEntry({
        id: "intro.md",
        frontmatter: { title: "Introduction", slug: "intro" },
      }),
      createMockDocEntry({
        id: "guide.md",
        frontmatter: { title: "Guide", slug: "guide" },
      }),
    ]);

    const manifest = await buildManifest(provider, basicConfig);

    expect(manifest.sidebars.default).toBeDefined();
    expect(manifest.sidebars.default.id).toBe("default");
    expect(manifest.sidebars.default.items).toHaveLength(2);
  });

  it("should extract headings from markdown content", async () => {
    const provider = new MockContentProvider([
      createMockDocEntry({
        body: `# Main Title

## Section One

Content here.

### Subsection

More content.

## Section Two
`,
      }),
    ]);

    const manifest = await buildManifest(provider, basicConfig);
    const page = manifest.pages["test-doc.md"];

    expect(page.headings).toHaveLength(4);
    expect(page.headings[0]).toEqual({
      level: 1,
      text: "Main Title",
      slug: "main-title",
    });
    expect(page.headings[1].text).toBe("Section One");
    expect(page.headings[2].text).toBe("Subsection");
    expect(page.headings[3].text).toBe("Section Two");
  });

  it("should handle custom slugs from frontmatter", async () => {
    const provider = new MockContentProvider([
      createMockDocEntry({
        frontmatter: {
          title: "Custom Page",
          slug: "/custom/path/to/page",
        },
      }),
    ]);

    const manifest = await buildManifest(provider, basicConfig);
    const page = manifest.pages["test-doc.md"];

    expect(page.slug).toBe("/custom/path/to/page");
    expect(page.path).toBe("/custom/path/to/page");
    expect(manifest.routes["/custom/path/to/page"]).toBe("test-doc.md");
  });

  it("should handle missing frontmatter fields gracefully", async () => {
    const provider = new MockContentProvider([
      createMockDocEntry({
        frontmatter: {}, // No title or description
      }),
    ]);

    const manifest = await buildManifest(provider, basicConfig);
    const page = manifest.pages["test-doc.md"];

    expect(page.title).toBe("Untitled");
    expect(page.description).toBeUndefined();
  });

  it("should handle empty provider", async () => {
    const provider = new MockContentProvider([]);

    const manifest = await buildManifest(provider, basicConfig);

    expect(Object.keys(manifest.pages)).toHaveLength(0);
    expect(Object.keys(manifest.posts)).toHaveLength(0);
    expect(Object.keys(manifest.apis)).toHaveLength(0);
    expect(manifest.sidebars.default.items).toHaveLength(0);
  });

  it("should handle mixed content types", async () => {
    const provider = new MockContentProvider([
      createMockDocEntry({ id: "doc1.md", frontmatter: { title: "Doc 1" } }),
      createMockPostEntry({
        id: "post1.md",
        frontmatter: { title: "Post 1", date: "2026-01-01" },
      }),
      createMockDocEntry({ id: "doc2.md", frontmatter: { title: "Doc 2" } }),
      createMockApiEntry({ id: "api1.json", frontmatter: { title: "API 1" } }),
      createMockPostEntry({
        id: "post2.md",
        frontmatter: { title: "Post 2", date: "2026-01-02" },
      }),
    ]);

    const manifest = await buildManifest(provider, basicConfig);

    expect(Object.keys(manifest.pages)).toHaveLength(2);
    expect(Object.keys(manifest.posts)).toHaveLength(2);
    expect(Object.keys(manifest.apis)).toHaveLength(1);

    // Sidebar should only include pages, not posts or apis
    expect(manifest.sidebars.default.items).toHaveLength(2);
  });

  it("should handle invalid JSON in API reference gracefully", async () => {
    const provider = new MockContentProvider([
      createMockApiEntry({
        body: "not valid json{]}",
      }),
    ]);

    const manifest = await buildManifest(provider, basicConfig);
    const api = manifest.apis["test-api.json"];

    // Should create the API reference but with empty spec
    expect(api).toBeDefined();
    expect(api.spec).toEqual({});
  });

  it("should preserve all frontmatter fields", async () => {
    const provider = new MockContentProvider([
      createMockDocEntry({
        frontmatter: {
          title: "Test",
          customField: "customValue",
          nested: { key: "value" },
        },
      }),
    ]);

    const manifest = await buildManifest(provider, basicConfig);
    const page = manifest.pages["test-doc.md"];

    expect(page.frontmatter.customField).toBe("customValue");
    expect(page.frontmatter.nested).toEqual({ key: "value" });
  });
});
