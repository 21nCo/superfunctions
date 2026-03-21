import React, { type ReactNode } from "react";
import type { DocHeading, DocsTopNavItem, Sidebar, Version } from "@docsfn/core";
import { DocsSidebar } from "./DocsSidebar";
import { DocsToc } from "./DocsToc";

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

export interface DocsLayoutProps {
  children: ReactNode;
  surface?: DocsPageSurface;
  sidebar?: Sidebar;
  headings?: DocHeading[];
  activePath?: string;
  topbar?: ReactNode;
}

export function DocsLayout({
  children,
  surface,
  sidebar,
  headings,
  activePath,
  topbar,
}: DocsLayoutProps) {
  const resolvedSidebar = sidebar ?? surface?.sidebar;
  const resolvedHeadings = headings ?? surface?.headings ?? [];
  const resolvedActivePath = activePath ?? surface?.route;

  return (
    <div className="docsfn-layout">
      {topbar ? <header className="docsfn-topbar">{topbar}</header> : null}

      <div className="docsfn-container">
        {resolvedSidebar ? (
          <aside className="docsfn-sidebar-col">
            <DocsSidebar
              surface={surface}
              sidebar={resolvedSidebar}
              activePath={resolvedActivePath}
            />
          </aside>
        ) : null}

        <main className="docsfn-main">{children}</main>

        {resolvedHeadings.length > 0 ? (
          <aside className="docsfn-toc-col">
            <DocsToc surface={surface} headings={resolvedHeadings} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
