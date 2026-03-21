import { describe, expect, it } from "vitest";
import { buildCanonicalBlogRecords } from "./blog";
import type { NormalizedPostRecord } from "./normalize";

function createPost(
  id: string,
  overrides: Partial<NormalizedPostRecord> = {}
): NormalizedPostRecord {
  const date = overrides.date ?? "2026-03-01";
  const frontmatter = {
    date,
    ...(overrides.frontmatter ?? {}),
  };

  return {
    id,
    slug: id.replace(/^blog:/, "").replace(".mdx", ""),
    path: `/blog/${id}`,
    title: id,
    date,
    tags: [],
    body: "# Heading\n\nBody text",
    frontmatter,
    ...overrides,
    frontmatter,
  };
}

describe("buildCanonicalBlogRecords", () => {
  it("normalizes blog fields, excludes drafts, and emits deterministic tag/pagination surfaces (TV-BLOG-001)", () => {
    const input: NormalizedPostRecord[] = [
      createPost("blog:alpha.mdx", {
        slug: "alpha",
        title: "Alpha",
        date: "2026-03-01",
        tags: ["Release"],
        body: "Alpha release details",
        frontmatter: {
          author: "Docs Team",
        },
      }),
      createPost("blog:beta.mdx", {
        slug: "beta",
        title: "Beta",
        date: "2026-03-02",
        tags: ["release", "platform"],
        body: "Beta release details",
      }),
      createPost("blog:draft.mdx", {
        slug: "draft-post",
        title: "Draft",
        date: "2026-03-03",
        tags: ["internal"],
        frontmatter: {
          draft: true,
        },
      }),
    ];

    const canonical = buildCanonicalBlogRecords({
      posts: input,
      basePath: "/docs",
      pageSize: 1,
    });

    expect(canonical.posts.map((post) => post.slug)).toEqual(["beta", "alpha"]);
    expect(canonical.posts.every((post) => post.path.startsWith("/docs/blog"))).toBe(true);
    expect(canonical.posts[0]).toMatchObject({
      title: "Beta",
      date: "2026-03-02",
      draft: false,
      tags: ["platform", "release"],
    });
    expect(canonical.posts[1].author).toBe("Docs Team");
    expect(canonical.posts[1].excerpt).toBeDefined();

    expect(canonical.listRoute).toBe("/docs/blog");
    expect(canonical.feedPath).toBe("/docs/blog/rss.xml");
    expect(canonical.postOrder).toEqual(["blog:beta.mdx", "blog:alpha.mdx"]);
    expect(Object.keys(canonical.tags)).toEqual(["platform", "release"]);
    expect(canonical.tags.release.path).toBe("/docs/blog/tags/release");
    expect(canonical.tags.release.postIds).toEqual(["blog:beta.mdx", "blog:alpha.mdx"]);
    expect(canonical.archives.map((archive) => archive.path)).toEqual([
      "/docs/blog",
      "/docs/blog/page/2",
    ]);
  });

  it("includes drafts only when preview mode is enabled", () => {
    const canonical = buildCanonicalBlogRecords({
      posts: [
        createPost("blog:draft.mdx", {
          slug: "draft-post",
          date: "2026-03-01",
          frontmatter: {
            draft: true,
          },
        }),
      ],
      preview: true,
      basePath: "/docs",
    });

    expect(canonical.posts).toHaveLength(1);
    expect(canonical.posts[0].draft).toBe(true);
  });

  it("throws DOCS_ARTIFACT_INVALID when publish date metadata is invalid", () => {
    expect(() =>
      buildCanonicalBlogRecords({
        posts: [
          createPost("blog:broken.mdx", {
            slug: "broken",
            date: "not-a-date",
          }),
        ],
        basePath: "/docs",
      })
    ).toThrowError(/DOCS_ARTIFACT_INVALID|invalid publish date metadata/);
  });

  it("is deterministic when provider entry order changes", () => {
    const source: NormalizedPostRecord[] = [
      createPost("blog:a.mdx", { slug: "a", date: "2026-03-01", tags: ["release"] }),
      createPost("blog:b.mdx", { slug: "b", date: "2026-03-02", tags: ["release", "platform"] }),
    ];

    const forward = buildCanonicalBlogRecords({ posts: source, basePath: "/docs" });
    const reversed = buildCanonicalBlogRecords({
      posts: [...source].reverse(),
      basePath: "/docs",
    });

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});
