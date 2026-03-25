export const SVELTE_PUBLIC_TYPES = `import type { ComponentType } from "svelte";
import type { DocHeading, DocsTopNavItem, Sidebar, Version } from "@docsfn/core/browser";

export interface DocsPageLink {
  title: string;
  path: string;
}

export interface DocsPageBreadcrumbItem {
  label: string;
  href: string;
}

export interface DocsPagePagination {
  prev?: DocsPageLink;
  next?: DocsPageLink;
}

export interface DocsPageSurface {
  route: string;
  title?: string;
  description?: string;
  canonicalPath?: string;
  canonicalUrl?: string;
  editLink?: string;
  pageActions?: Array<Record<string, unknown>>;
  sidebar?: Sidebar;
  sidebarId?: string;
  headings?: DocHeading[];
  breadcrumbs?: DocsPageBreadcrumbItem[];
  pagination?: DocsPagePagination;
  topNav?: DocsTopNavItem[];
  versions?: Version[];
  currentVersion?: string;
  versionLinks?: Record<string, string>;
}

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface PaginationPage {
  title: string;
  path: string;
}

export interface TopBarLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface TopBarDropdown {
  label: string;
  items: TopBarLink[];
}

export type TopBarItem = TopBarLink | TopBarDropdown;

export const DocsLayout: ComponentType;
export const DocsContent: ComponentType;
export const DocsSidebar: ComponentType;
export const SidebarGroup: ComponentType;
export const DocsToc: ComponentType;
export const DocsSearch: ComponentType;
export const TopBar: ComponentType;
export const Pagination: ComponentType;
export const Breadcrumbs: ComponentType;
export const VersionSwitcher: ComponentType;
export const ApiReferenceRenderer: ComponentType;
export const EmbeddedPage: ComponentType;
`;
