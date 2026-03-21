import { assertValidBlogPublishMetadata, resolveBlogLastBuildDate } from "./blog";
import type { BlogPost, DocsManifest } from "./types";

export interface RSSFeedOptions {
  title: string;
  description: string;
  link: string;
  language?: string;
}

/**
 * Generate RSS 2.0 feed XML from blog posts
 */
export function generateRSSFeed(
  manifest: DocsManifest,
  options: RSSFeedOptions
): string {
  const { title, description, link, language = "en" } = options;

  const normalizedLink = link.replace(/\/+$/, "");
  const orderedIds = manifest.blog?.postOrder ?? [];
  const orderedPostsFromManifest = orderedIds
    .map((id) => manifest.posts[id])
    .filter((post): post is BlogPost => Boolean(post));
  const posts =
    orderedPostsFromManifest.length > 0
      ? orderedPostsFromManifest
      : Object.values(manifest.posts).sort((left, right) => {
          const leftDate = assertValidBlogPublishMetadata(left).timestamp;
          const rightDate = assertValidBlogPublishMetadata(right).timestamp;
          if (leftDate !== rightDate) {
            return rightDate - leftDate;
          }
          return left.slug.localeCompare(right.slug, "en", {
            sensitivity: "variant",
            numeric: true,
          });
        });

  const items = posts
    .map((post) => {
      const publish = assertValidBlogPublishMetadata(post);
      const postLink = `${normalizedLink}${post.path}`;
      const descriptionValue = post.excerpt ?? post.summary;
      return `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${escapeXml(postLink)}</link>
      <guid isPermaLink="true">${escapeXml(postLink)}</guid>
      <pubDate>${new Date(publish.publishedAt).toUTCString()}</pubDate>
      ${descriptionValue ? `<description><![CDATA[${descriptionValue}]]></description>` : ""}
      ${post.author ? `<author>${escapeXml(post.author)}</author>` : ""}
      ${post.tags.map((tag) => `<category>${escapeXml(tag)}</category>`).join("\n      ")}
    </item>
  `;
    })
    .join("");

  const feedPath = manifest.blog?.feedPath ?? "/rss.xml";
  const feedLink = `${normalizedLink}${feedPath}`;
  const lastBuildDate = resolveBlogLastBuildDate(posts);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <description>${escapeXml(description)}</description>
    <link>${escapeXml(normalizedLink)}</link>
    <language>${escapeXml(language)}</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <atom:link href="${escapeXml(feedLink)}" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
