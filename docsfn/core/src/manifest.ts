import { DocsContentProvider, DocsManifest, DocPage, BlogPost, RawContentEntry } from './types';
import { extractHeadings } from './markdown';
import { buildAutoSidebar } from './sidebar';

export interface DocsConfig {
  site: {
    title: string;
    description?: string;
  };
  // sidebar config could go here
}

export async function buildManifest(provider: DocsContentProvider, config: DocsConfig): Promise<DocsManifest> {
  const entries = await provider.list();
  
  const pages: Record<string, DocPage> = {};
  const posts: Record<string, BlogPost> = {};
  const apis: Record<string, ApiReference> = {};
  const routes: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.kind === 'page') {
      // ... existing page logic
      // (I need to be careful with replace to not delete logic, so I'll try to match exact block)

      const headings = extractHeadings(entry.body);
      const slug = entry.frontmatter.slug || entry.id.replace(/\.mdx?$/, ''); // simple slug
      const path = slug.startsWith('/') ? slug : `/${slug}`;
      
      const page: DocPage = {
        kind: 'page',
        id: entry.id,
        slug,
        path,
        title: entry.frontmatter.title || 'Untitled',
        description: entry.frontmatter.description,
        body: entry.body,
        headings,
        frontmatter: entry.frontmatter
      };
      
      pages[entry.id] = page;
      routes[path] = entry.id;
    } else if (entry.kind === 'post') {
      const slug = entry.frontmatter.slug || entry.id.replace(/\.mdx?$/, '');
      const path = `/blog/${slug}`;
      
      const post: BlogPost = {
        kind: 'post',
        id: entry.id,
        slug,
        path,
        title: entry.frontmatter.title || 'Untitled',
        date: entry.frontmatter.date || new Date().toISOString(),
        tags: entry.frontmatter.tags || [],
        body: entry.body,
        frontmatter: entry.frontmatter
      };
      
      posts[entry.id] = post;
      routes[path] = entry.id;
    } else if (entry.kind === 'api') {
      const slug = entry.frontmatter.slug || entry.id.replace(/\.(json|yaml|yml)$/, '');
      const path = `/api/${slug}`;
      
      // Assume body is stringified JSON/YAML, we might need to parse it if we want 'spec' as object.
      // But RawContentEntry.body is string.
      // For now, store raw body or try to parse if JSON.
      let spec = {};
      try {
        spec = JSON.parse(entry.body);
      } catch (e) {
        // if yaml, we need a parser. Core might not have yaml parser.
        // For now, assume JSON or keep raw string in a real implementation.
        // Spec says "Raw OpenAPI spec object".
      }

      const api: ApiReference = {
        kind: 'api',
        id: entry.id,
        slug,
        path,
        title: entry.frontmatter.title || 'API Reference',
        spec,
        frontmatter: entry.frontmatter
      };
      
      apis[entry.id] = api;
      routes[path] = entry.id;
    }
  }

  const defaultSidebar = buildAutoSidebar(Object.values(pages));

  const sidebars = {
    default: defaultSidebar
  };

  return {
    site: config.site,
    pages,
    posts,
    apis,
    sidebars,
    routes
  };
}
