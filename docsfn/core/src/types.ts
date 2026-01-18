export type ContentKind = 'page' | 'post' | 'api' | 'asset';

export interface DocPage {
  kind: 'page';
  id: string; // unique stable ID
  slug: string; // url path segment
  path: string; // full path for routing
  title: string;
  description?: string;
  body: string; // raw markdown
  headings: DocHeading[];
  frontmatter: Record<string, any>;
  lastUpdated?: number;
}

export interface BlogPost {
  kind: 'post';
  id: string;
  slug: string;
  path: string;
  title: string;
  date: string; // ISO date
  author?: string;
  excerpt?: string;
  tags: string[];
  body: string;
  frontmatter: Record<string, any>;
}

export interface DocHeading {
  level: number;
  text: string;
  slug: string; // anchor id
}

export interface SidebarItem {
  type: 'link' | 'group' | 'separator';
  text: string;
  link?: string; // for links
  items?: SidebarItem[]; // for groups
  collapsed?: boolean;
}

export interface Sidebar {
  id: string;
  items: SidebarItem[];
}

export interface DocsManifest {
  site: {
    title: string;
    description?: string;
  };
  pages: Record<string, DocPage>; // keyed by ID
  posts: Record<string, BlogPost>;
  sidebars: Record<string, Sidebar>;
  routes: Record<string, string>; // path -> ID map for routing
}

export interface RawContentEntry {
  id: string;
  kind: ContentKind;
  body: string;
  frontmatter: Record<string, any>;
  filepath?: string;
}

export interface DocsContentProvider {
  list(): Promise<RawContentEntry[]>;
}
