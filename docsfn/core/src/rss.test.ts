import { describe, expect, it } from "vitest";
import { buildCanonicalBlogRecords } from "./blog";
import { generateRSSFeed } from "./rss";
import type { DocsManifest } from "./types";

function createManifest(): DocsManifest {
  const canonicalBlog = buildCanonicalBlogRecords({
    posts: [
      {
        id: "blog:alpha.mdx",
        slug: "alpha",
        path: "/blog/alpha",
        title: "Alpha",
        date: "2026-03-01",
        tags: ["release"],
        body: "Alpha release details",
        frontmatter: {
          date: "2026-03-01",
          excerpt: "Alpha excerpt",
          author: "Core Team",
        },
      },
      {
        id: "blog:beta.mdx",
        slug: "beta",
        path: "/blog/beta",
        title: "Beta",
        date: "2026-03-02",
        tags: ["release", "platform"],
        body: "Beta release details",
        frontmatter: {
          date: "2026-03-02",
          excerpt: "Beta excerpt",
        },
      },
    ],
    basePath: "/docs",
  });

  return {
    site: {
      title: "Docs",
    },
    pages: {},
    posts: Object.fromEntries(canonicalBlog.posts.map((post) => [post.id, post])),
    apis: {},
    sidebars: {},
    routes: Object.fromEntries(canonicalBlog.posts.map((post) => [post.path, post.id])),
    blog: {
      listRoute: canonicalBlog.listRoute,
      feedPath: canonicalBlog.feedPath,
      postOrder: canonicalBlog.postOrder,
      tags: canonicalBlog.tags,
      archives: canonicalBlog.archives,
    },
  };
}

describe("generateRSSFeed", () => {
  it("emits deterministic RSS with canonical post order and feed location", () => {
    const manifest = createManifest();
    const rssA = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Release updates",
      link: "https://docs.example.com",
    });
    const rssB = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Release updates",
      link: "https://docs.example.com",
    });

    expect(rssA).toBe(rssB);
    expect(rssA).toContain("<atom:link href=\"https://docs.example.com/docs/blog/rss.xml\"");
    expect(rssA.indexOf("/docs/blog/beta")).toBeLessThan(rssA.indexOf("/docs/blog/alpha"));
    expect(rssA).toContain(
      `<lastBuildDate>${new Date("2026-03-02T00:00:00.000Z").toUTCString()}</lastBuildDate>`
    );
  });

  it("uses feedHref and itemHref when the public blog URLs differ from manifest paths", () => {
    const manifest = createManifest();
    const rss = generateRSSFeed(manifest, {
      title: "Docs Blog",
      description: "Release updates",
      link: "https://app.example.com/blog",
      feedHref: "https://app.example.com/blog/rss.xml",
      itemHref: (post) => `https://app.example.com/blog/${post.slug}`,
    });

    expect(rss).toContain(
      "<atom:link href=\"https://app.example.com/blog/rss.xml\" rel=\"self\" type=\"application/rss+xml\"/>"
    );
    expect(rss).toContain("<link>https://app.example.com/blog</link>");
    expect(rss).toContain("<link>https://app.example.com/blog/beta</link>");
    expect(rss).not.toContain("https://app.example.com/blog/docs/blog/");
  });

  it("fails closed on invalid publish metadata", () => {
    const manifest = createManifest();
    manifest.posts["blog:broken.mdx"] = {
      kind: "post",
      id: "blog:broken.mdx",
      slug: "broken",
      path: "/docs/blog/broken",
      title: "Broken",
      date: "invalid-date",
      tags: [],
      body: "broken",
      frontmatter: {},
    };
    manifest.blog = {
      ...manifest.blog!,
      postOrder: ["blog:broken.mdx", ...manifest.blog!.postOrder],
    };

    expect(() =>
      generateRSSFeed(manifest, {
        title: "Docs Blog",
        description: "Release updates",
        link: "https://docs.example.com",
      })
    ).toThrowError(/DOCS_ARTIFACT_INVALID|invalid publish date metadata/);
  });
});
