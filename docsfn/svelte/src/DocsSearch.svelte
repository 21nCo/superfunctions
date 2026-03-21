<script lang="ts">
  import { onMount } from "svelte";
  import {
    createDocsSearchRuntime,
    maybeEmitAnalyticsEvent,
    type DocsAnalyticsEvent,
    type DocsSearchArtifact,
    type DocsSearchRuntime,
    type DocsSearchRuntimeResultItem,
    type DocsSearchScope,
  } from "@docsfn/core";
  import {
    Dialog,
    DialogPortal,
    DialogOverlay,
    DialogContent,
    ScrollArea,
    ScrollAreaViewport,
  } from "@uifn/svelte";

  type SearchScopeFilter = DocsSearchScope | "all";

  export let searchArtifact: DocsSearchArtifact | undefined = undefined;
  export let searchIndex: DocsSearchArtifact | undefined = undefined;
  export let loadSearchArtifact: (() => Promise<DocsSearchArtifact>) | undefined =
    undefined;
  export let placeholder = "Search docs...";
  export let initialScope: SearchScopeFilter = "all";
  export let scopes: SearchScopeFilter[] = ["all", "docs", "api", "blog"];
  export let analytics:
    | {
        enabled?: boolean;
        respectDnt?: boolean;
        route?: string;
        onEvent?: (event: DocsAnalyticsEvent) => void;
      }
    | undefined = undefined;

  let isOpen = false;
  let query = "";
  let results: DocsSearchRuntimeResultItem[] = [];
  let selectedIndex = 0;
  let scope: SearchScopeFilter = initialScope;
  let inputRef: HTMLInputElement;
  let runtime: DocsSearchRuntime | null = null;
  let requestVersion = 0;

  function normalizeScopes(input: SearchScopeFilter[]): SearchScopeFilter[] {
    return [...new Set(input)].sort((left, right) =>
      left.localeCompare(right, "en", { sensitivity: "variant", numeric: true })
    );
  }

  $: supportedScopes = normalizeScopes(scopes);
  $: runtime = createDocsSearchRuntime({
    artifact: searchArtifact ?? searchIndex,
    loadArtifact: loadSearchArtifact,
  });

  async function runQuery() {
    if (!runtime || query.trim().length === 0) {
      results = [];
      selectedIndex = 0;
      return;
    }

    const currentVersion = ++requestVersion;
    try {
      const nextResults = await runtime.query({
        query,
        scope,
        limit: 10,
      });
      if (requestVersion !== currentVersion) {
        return;
      }
      results = nextResults;
      selectedIndex = 0;
      maybeEmitAnalyticsEvent({
        enabled: Boolean(analytics?.enabled),
        respectDnt: analytics?.respectDnt ?? true,
        event: {
          name: "docs.search",
          timestamp: new Date().toISOString(),
          route: analytics?.route ?? window.location.pathname,
          searchScope: scope === "all" ? undefined : scope,
          resultCount: nextResults.length,
        },
        emit: (event) => analytics?.onEvent?.(event),
      });
    } catch {
      if (requestVersion !== currentVersion) {
        return;
      }
      results = [];
      selectedIndex = 0;
    }
  }

  $: void runQuery();

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        isOpen = true;
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  $: if (isOpen && inputRef) {
    inputRef.focus();
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (results.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (event.key === "Enter" && results[selectedIndex]) {
      event.preventDefault();
      handleResultClick(results[selectedIndex]);
    }
  }

  function handleResultClick(result: DocsSearchRuntimeResultItem) {
    maybeEmitAnalyticsEvent({
      enabled: Boolean(analytics?.enabled),
      respectDnt: analytics?.respectDnt ?? true,
      event: {
        name: "docs.search_result_click",
        timestamp: new Date().toISOString(),
        route: analytics?.route ?? window.location.pathname,
        searchScope: result.scope,
        targetUrl: result.path,
      },
      emit: (event) => analytics?.onEvent?.(event),
    });
    window.location.href = result.path;
    isOpen = false;
  }

  function handleOpenChange(open: boolean) {
    isOpen = open;
    if (!open) {
      query = "";
      results = [];
      selectedIndex = 0;
    }
  }
</script>

<Dialog bind:open={isOpen} onOpenChange={handleOpenChange}>
  <button
    class="docsfn-search-trigger"
    on:click={() => (isOpen = true)}
    aria-label="Search documentation"
  >
    <span class="docsfn-search-icon" aria-hidden="true">🔍</span>
    <span class="docsfn-search-placeholder">{placeholder}</span>
    <kbd class="docsfn-search-kbd">
      <span>⌘</span>
      <span>K</span>
    </kbd>
  </button>

  <DialogPortal>
    <DialogOverlay class="docsfn-search-overlay" />
    <DialogContent class="docsfn-search-content" on:keydown={handleKeyDown}>
      <div class="docsfn-search-header">
        <span class="docsfn-search-icon" aria-hidden="true">🔍</span>
        <input
          bind:this={inputRef}
          type="text"
          class="docsfn-search-input"
          {placeholder}
          bind:value={query}
          aria-label="Search query"
        />
        <select bind:value={scope} aria-label="Search scope">
          {#each supportedScopes as option}
            <option value={option}>{option}</option>
          {/each}
        </select>
        {#if query}
          <button
            on:click={() => (query = "")}
            class="docsfn-search-clear"
            aria-label="Clear search"
          >
            ✕
          </button>
        {/if}
      </div>

      <ScrollArea class="docsfn-search-results">
        <ScrollAreaViewport>
          {#if results.length === 0 && query}
            <div class="docsfn-search-empty">
              <p>No results found for "{query}"</p>
            </div>
          {:else if results.length === 0 && !query}
            <div class="docsfn-search-empty">
              <p>Start typing to search...</p>
            </div>
          {:else}
            <div class="docsfn-search-results-list">
              {#each results as result, index (`${result.id}:${result.path}`)}
                <button
                  on:click={() => handleResultClick(result)}
                  class="docsfn-search-item {index === selectedIndex ? 'selected' : ''}"
                  data-selected={index === selectedIndex}
                >
                  <div class="docsfn-search-item-header">
                    <span class="docsfn-search-item-kind">
                      {result.kind === "page" ? "📄" : result.kind === "post" ? "📝" : "🔧"}
                    </span>
                    <span class="docsfn-search-item-title">{result.title}</span>
                  </div>
                  {#if result.summary}
                    <p class="docsfn-search-item-desc">{result.summary}</p>
                  {/if}
                  <div class="docsfn-search-item-footer">
                    <span class="docsfn-search-item-path">{result.path}</span>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </ScrollAreaViewport>
      </ScrollArea>
    </DialogContent>
  </DialogPortal>
</Dialog>
