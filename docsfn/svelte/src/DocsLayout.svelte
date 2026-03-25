<script lang="ts">
  import type { DocHeading, DocsTopNavItem, Sidebar, Version } from "@docsfn/core/browser";
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

  let sidebarOpen = false;
</script>

<div class="docsfn-layout">
  <header class="docsfn-topbar">
    <slot name="topbar" />
  </header>

  {#if resolvedSidebar}
    <div class="docsfn-mobile-toolbar">
      <button
        type="button"
        class="docsfn-mobile-menu-btn"
        aria-expanded={sidebarOpen}
        aria-controls="docsfn-sidebar-panel"
        on:click={() => (sidebarOpen = !sidebarOpen)}
      >
        Menu
      </button>
    </div>

    {#if sidebarOpen}
      <button
        type="button"
        class="docsfn-mobile-backdrop"
        aria-label="Close menu"
        on:click={() => (sidebarOpen = false)}
      ></button>
    {/if}
  {/if}

  <div class="docsfn-container">
    {#if resolvedSidebar}
      <aside
        id="docsfn-sidebar-panel"
        class="docsfn-sidebar-col"
        class:docsfn-sidebar-col--open={sidebarOpen}
      >
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

<style>
  .docsfn-mobile-toolbar {
    display: block;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--docsfn-color-border, #e2e8f0);
    background: var(--docsfn-color-surface, #fff);
  }

  @media (min-width: 1024px) {
    .docsfn-mobile-toolbar {
      display: none;
    }
  }

  .docsfn-mobile-menu-btn {
    font: inherit;
    font-size: 0.875rem;
    padding: 0.4rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid var(--docsfn-color-border, #e2e8f0);
    background: var(--docsfn-color-surface, #fff);
    cursor: pointer;
  }

  .docsfn-mobile-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    border: none;
    padding: 0;
    margin: 0;
    background: rgb(15 23 42 / 0.4);
    cursor: pointer;
  }

  @media (max-width: 1023px) {
    .docsfn-sidebar-col {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: min(18rem, 88vw);
      z-index: 40;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      overflow-y: auto;
      box-shadow: 4px 0 24px rgb(15 23 42 / 0.12);
    }

    .docsfn-sidebar-col--open {
      transform: translateX(0);
    }
  }
</style>
