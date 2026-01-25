import type { DocsManifest } from "./types";

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

  const posts = Object.values(manifest.posts).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const items = posts
    .map(
      (post) => `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${link}${post.path}</link>
      <guid isPermaLink="true">${link}${post.path}</guid>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
      ${post.excerpt ? `<description><![CDATA[${post.excerpt}]]></description>` : ""}
      ${post.author ? `<author>${post.author}</author>` : ""}
      ${post.tags.map((tag) => `<category>${tag}</category>`).join("\n      ")}
    </item>
  `
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${title}</title>
    <description>${description}</description>
    <link>${link}</link>
    <language>${language}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${link}/rss.xml" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;
}
