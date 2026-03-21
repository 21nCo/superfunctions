<script lang="ts">
  import type { DocHeading, DocsTopNavItem, Sidebar, Version } from "@docsfn/core";
  import DocsSidebar from "./DocsSidebar.svelte";
  import DocsToc from "./DocsToc.svelte";

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

  export let surface: DocsPageSurface | undefined = undefined;
  export let sidebar: Sidebar | undefined = undefined;
  export let headings: DocHeading[] | undefined = undefined;
  export let activePath: string | undefined = undefined;

  $: resolvedSidebar = sidebar ?? surface?.sidebar;
  $: resolvedHeadings = headings ?? surface?.headings ?? [];
  $: resolvedActivePath = activePath ?? surface?.route;
</script>

<div class="docsfn-layout">
  <header class="docsfn-topbar">
    <slot name="topbar" />
  </header>

  <div class="docsfn-container">
    {#if resolvedSidebar}
      <aside class="docsfn-sidebar-col">
        <DocsSidebar surface={surface} sidebar={resolvedSidebar} activePath={resolvedActivePath} />
      </aside>
    {/if}

    <main class="docsfn-main">
      <slot />
    </main>

    {#if resolvedHeadings.length > 0}
      <aside class="docsfn-toc-col">
        <DocsToc surface={surface} headings={resolvedHeadings} />
      </aside>
    {/if}
  </div>
</div>
