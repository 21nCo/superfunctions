import { createDiagnostic, createDocsError } from "./diagnostics";
import type { NormalizedPostRecord } from "./normalize";
import type {
  BlogArchivePage,
  BlogManifestSurface,
  BlogPost,
  BlogTagIndex,
} from "./types";

export interface BuildCanonicalBlogRecordsInput {
  posts: NormalizedPostRecord[];
  basePath?: string;
  preview?: boolean;
  pageSize?: number;
}

export interface CanonicalBlogBuildResult extends BlogManifestSurface {
  posts: BlogPost[];
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, "en", {
    sensitivity: "variant",
    numeric: true,
  });
}

function normalizeBasePath(basePath?: string): string {
  const value = typeof basePath === "string" && basePath.length > 0 ? basePath : "/docs";
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : prefixed;
}

function stripMarkdown(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(source: string, maxLength = 220): string {
  const normalized = stripMarkdown(source);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function toTagSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "tag";
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const canonical = tag.trim().toLowerCase();
    if (!canonical || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    normalized.push(canonical);
  }
  return normalized.sort(compareStrings);
}

function parseDraftFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "yes" || normalized === "1";
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return false;
}

function parseAuthor(frontmatter: Record<string, unknown>): string | undefined {
  const rawAuthor = frontmatter.author;
  if (typeof rawAuthor === "string" && rawAuthor.trim().length > 0) {
    return rawAuthor.trim();
  }
  if (typeof rawAuthor === "object" && rawAuthor !== null) {
    const fromObject =
      typeof (rawAuthor as { name?: unknown }).name === "string"
        ? String((rawAuthor as { name: string }).name).trim()
        : "";
    if (fromObject.length > 0) {
      return fromObject;
    }
  }
  return undefined;
}

function parseExcerpt(input: {
  excerpt?: unknown;
  body: string;
}): string | undefined {
  if (typeof input.excerpt === "string" && input.excerpt.trim().length > 0) {
    return input.excerpt.trim();
  }
  const summary = summarize(input.body);
  return summary.length > 0 ? summary : undefined;
}

function parsePublishedDate(input: { date: string; sourceId: string }): {
  date: string;
  publishedAt: string;
  timestamp: number;
} {
  const timestamp = Date.parse(input.date);
  if (!Number.isFinite(timestamp)) {
    throw createDocsError({
      code: "DOCS_ARTIFACT_INVALID",
      message: `blog post ${input.sourceId} has invalid publish date metadata`,
      diagnostics: [
        createDiagnostic({
          code: "DOCS_ARTIFACT_INVALID",
          message: `blog post ${input.sourceId} has invalid publish date metadata`,
          details: {
            sourceId: input.sourceId,
            date: input.date,
          },
        }),
      ],
    });
  }

  const published = new Date(timestamp).toISOString();
  return {
    date: published.slice(0, 10),
    publishedAt: published,
    timestamp,
  };
}

function buildArchivePages(input: {
  orderedPosts: BlogPost[];
  listRoute: string;
  pageSize: number;
}): BlogArchivePage[] {
  const totalPosts = input.orderedPosts.length;
  const totalPages = Math.max(1, Math.ceil(totalPosts / input.pageSize));
  const pages: BlogArchivePage[] = [];

  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * input.pageSize;
    const slice = input.orderedPosts.slice(start, start + input.pageSize);
    pages.push({
      page,
      path: page === 1 ? input.listRoute : `${input.listRoute}/page/${page}`,
      postIds: slice.map((post) => post.id),
      totalPages,
      totalPosts,
      pageSize: input.pageSize,
    });
  }

  return pages;
}

function buildTagIndexes(input: {
  orderedPosts: BlogPost[];
  listRoute: string;
}): Record<string, BlogTagIndex> {
  const tagMap = new Map<string, BlogTagIndex>();
  for (const post of input.orderedPosts) {
    for (const tag of post.tags) {
      const slug = toTagSlug(tag);
      const existing = tagMap.get(tag);
      if (existing) {
        existing.postIds.push(post.id);
        continue;
      }
      tagMap.set(tag, {
        tag,
        slug,
        path: `${input.listRoute}/tags/${slug}`,
        postIds: [post.id],
      });
    }
  }

  return Object.fromEntries(
    [...tagMap.entries()].sort(([left], [right]) => compareStrings(left, right))
  );
}

export function assertValidBlogPublishMetadata(post: Pick<BlogPost, "id" | "date">): {
  date: string;
  publishedAt: string;
  timestamp: number;
} {
  return parsePublishedDate({
    date: post.date,
    sourceId: post.id,
  });
}

export function resolveBlogLastBuildDate(posts: Array<Pick<BlogPost, "id" | "date">>): string {
  if (posts.length === 0) {
    return new Date("1970-01-01T00:00:00.000Z").toUTCString();
  }

  const latest = [...posts]
    .map((post) => ({
      id: post.id,
      ...assertValidBlogPublishMetadata(post),
    }))
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
      }
      return compareStrings(left.id, right.id);
    })[0];

  return new Date(latest.publishedAt).toUTCString();
}

export function buildCanonicalBlogRecords(
  input: BuildCanonicalBlogRecordsInput
): CanonicalBlogBuildResult {
  const basePath = normalizeBasePath(input.basePath);
  const listRoute = `${basePath}/blog`;
  const feedPath = `${listRoute}/rss.xml`;
  const includeDrafts = Boolean(input.preview);
  const pageSize = Math.max(1, Math.trunc(input.pageSize ?? 10));

  const canonicalPosts = input.posts
    .map((post) => {
      const frontmatterDate = post.frontmatter?.date;
      if (!(typeof frontmatterDate === "string" && frontmatterDate.trim().length > 0)) {
        throw createDocsError({
          code: "DOCS_ARTIFACT_INVALID",
          message: `blog post ${post.id} is missing publish date metadata`,
          diagnostics: [
            createDiagnostic({
              code: "DOCS_ARTIFACT_INVALID",
              message: `blog post ${post.id} is missing publish date metadata`,
              details: {
                sourceId: post.id,
              },
            }),
          ],
        });
      }

      const draft = parseDraftFlag(post.frontmatter?.draft);
      const publish = parsePublishedDate({
        date: frontmatterDate,
        sourceId: post.id,
      });
      const tags = normalizeTags(post.tags);
      const excerpt = parseExcerpt({
        excerpt: post.frontmatter?.excerpt,
        body: post.body,
      });

      return {
        kind: "post" as const,
        id: post.id,
        slug: post.slug,
        path: post.slug ? `${listRoute}/${post.slug}` : listRoute,
        title: post.title,
        date: publish.date,
        publishedAt: publish.publishedAt,
        author: parseAuthor(post.frontmatter),
        excerpt,
        summary: excerpt ?? summarize(post.body),
        draft,
        tags,
        body: post.body,
        frontmatter: post.frontmatter,
        _sortTimestamp: publish.timestamp,
      };
    })
    .filter((post) => includeDrafts || !post.draft)
    .sort((left, right) => {
      if (left._sortTimestamp !== right._sortTimestamp) {
        return right._sortTimestamp - left._sortTimestamp;
      }
      const slugCompare = compareStrings(left.slug, right.slug);
      if (slugCompare !== 0) {
        return slugCompare;
      }
      return compareStrings(left.id, right.id);
    });

  const posts = canonicalPosts.map(({ _sortTimestamp, ...post }) => post);
  const tags = buildTagIndexes({ orderedPosts: posts, listRoute });
  const archives = buildArchivePages({
    orderedPosts: posts,
    listRoute,
    pageSize,
  });
  const postOrder = posts.map((post) => post.id);

  return {
    posts,
    listRoute,
    feedPath,
    postOrder,
    tags,
    archives,
  };
}
