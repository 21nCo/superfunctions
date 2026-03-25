<script lang="ts">
  import "../app.css";
  import DocsSiteSearch from "$lib/components/DocsSiteSearch.svelte";
  import TopBar from "@site/topbar";
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
  });
</script>

<div class="docsfn-site-root">
  <TopBar
    items={data.source.config.navigation?.topNav}
    searchTrigger={clientSearchReady ? DocsSiteSearch : undefined}
  />
  <div class="docsfn-site-main">
    {@render children()}
  </div>
  <footer class="docsfn-site-footer">
    <p>Built at <a href="https://21n.co" rel="noreferrer noopener">21n.co</a></p>
  </footer>
</div>

<style>
  .docsfn-site-root {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .docsfn-site-main {
    flex: 1;
  }

  .docsfn-site-footer {
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
