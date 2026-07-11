<script lang="ts">
  import "../app.css";
  import DocsSiteSearch from "$lib/components/DocsSiteSearch.svelte";
  import TopBar from "@site/topbar";
  import { page } from "$app/stores";
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import type { LayoutData } from "./$types";

  interface Props {
    data: LayoutData;
    children: Snippet;
  }

  let { data, children }: Props = $props();

  /** DocsSearch uses uifn Dialog with runes that cannot SSR; mount after hydrate. */
  let clientSearchReady = $state(false);
  onMount(() => {
    clientSearchReady = true;

    const shouldKeepEmbedMode = (url: URL) =>
      url.origin === window.location.origin &&
      ["/docs", "/blog", "/changelog"].some(
        (route) => url.pathname === route || url.pathname.startsWith(`${route}/`)
      );

    const handleClick = (event: MouseEvent) => {
      if (!data.embed || event.defaultPrevented || event.button !== 0) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (!(event.target instanceof Element)) {
        return;
      }

      const anchor = event.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      if (anchor.target && anchor.target !== "_self") {
        return;
      }
      if (anchor.hasAttribute("download")) {
        return;
      }

      const rawHref = anchor.getAttribute("href");
      if (!rawHref || rawHref.startsWith("#")) {
        return;
      }

      const nextUrl = new URL(anchor.href, window.location.href);
      if (!shouldKeepEmbedMode(nextUrl) || nextUrl.searchParams.get("embed") === "1") {
        return;
      }

      nextUrl.searchParams.set("embed", "1");
      anchor.href = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
    };

    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
    };
  });
</script>

<div
  class="docsfn-site-root"
  class:docsfn-embed={data.embed}
  class:docsfn-docs-chrome={!data.embed && $page.url.pathname.startsWith("/docs")}
>
  <!-- <TopBar
    items={data.source.config.navigation?.topNav}
    searchTrigger={clientSearchReady ? DocsSiteSearch : undefined}
  /> -->
  <div class="docsfn-site-main">
    {@render children()}
  </div>
  {#if !data.embed && data.source.config.site.showFooter !== false}
    <footer class="docsfn-site-footer">
      <p>Built at <a href="https://21n.co" rel="noreferrer noopener">21n.co</a></p>
    </footer>
  {/if}
</div>

<style>
  .docsfn-site-root {
    min-height: 100vh;
    width: 100%;
    max-width: none;
    display: flex;
    flex-direction: column;
  }

  .docsfn-site-main {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .docsfn-site-root.docsfn-embed {
    min-height: auto;
    background: transparent;
  }

  .docsfn-site-root.docsfn-embed .docsfn-site-main {
    display: block;
  }

  .docsfn-site-footer {
    flex-shrink: 0;
    align-self: stretch;
    width: 100%;
    max-width: none;
    box-sizing: border-box;
    position: relative;
    z-index: 2;
    border-top: 1px solid var(--docsfn-color-border);
    padding: 1rem 1.5rem;
    text-align: center;
    font-size: 0.875rem;
    color: var(--docsfn-color-muted);
    background: var(--docsfn-color-surface);
    transition: var(--docsfn-transition-theme);
  }

  .docsfn-site-footer p {
    margin: 0;
  }

  .docsfn-site-footer a {
    color: var(--docsfn-color-primary);
    text-decoration: none;
    font-weight: 500;
  }

  .docsfn-site-footer a:hover {
    text-decoration: underline;
  }
</style>
