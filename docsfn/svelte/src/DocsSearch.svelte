<script lang="ts">
  import { onMount } from 'svelte';
  import { InMemorySearchFn } from 'searchfn';
  import {
    Dialog,
    DialogPortal,
    DialogOverlay,
    DialogContent,
    ScrollArea,
    ScrollAreaViewport,
  } from '@uifn/svelte';

  export let searchIndex: any;
  export let placeholder = 'Search docs...';

  let isOpen = false;
  let query = '';
  let results: any[] = [];
  let selectedIndex = 0;
  let engine: InMemorySearchFn | null = null;
  let inputRef: HTMLInputElement;

  // ⌘K keyboard shortcut
  onMount(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        isOpen = true;
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  // Initialize search engine
  $: if (searchIndex && !engine) {
    engine = new InMemorySearchFn({
      fields: ['title', 'description', 'headings', 'tags', 'body']
    });
    engine.importSnapshot(searchIndex);
  }

  // Search for results
  $: if (engine && query) {
    results = engine.searchDetailed(query, { limit: 10, includeStored: true });
    selectedIndex = 0;
  } else {
    results = [];
    selectedIndex = 0;
  }

  // Auto-focus input when dialog opens
  $: if (isOpen && inputRef) {
    inputRef.focus();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      window.location.href = results[selectedIndex].document.path;
      isOpen = false;
    }
  }

  function handleResultClick(path: string) {
    window.location.href = path;
    isOpen = false;
  }

  function handleOpenChange(open: boolean) {
    isOpen = open;
    if (!open) {
      query = '';
      results = [];
      selectedIndex = 0;
    }
  }
</script>

<Dialog bind:open={isOpen} onOpenChange={handleOpenChange}>
  <button 
    class="docsfn-search-trigger" 
    on:click={() => isOpen = true}
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
        {#if query}
          <button 
            on:click={() => query = ''}
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
              {#each results as hit, index (hit.docId)}
                <button
                  on:click={() => handleResultClick(hit.document.path)}
                  class="docsfn-search-item {index === selectedIndex ? 'selected' : ''}"
                  data-selected={index === selectedIndex}
                >
                  <div class="docsfn-search-item-header">
                    <span class="docsfn-search-item-kind">
                      {hit.document.kind === 'page' ? '📄' : hit.document.kind === 'post' ? '📝' : '🔧'}
                    </span>
                    <span class="docsfn-search-item-title">{hit.document.title}</span>
                  </div>
                  {#if hit.document.description}
                    <p class="docsfn-search-item-desc">{hit.document.description}</p>
                  {/if}
                  <div class="docsfn-search-item-footer">
                    <span class="docsfn-search-item-path">{hit.document.path}</span>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </ScrollAreaViewport>
      </ScrollArea>

      <div class="docsfn-search-footer">
        <div class="docsfn-search-commands">
          <kbd>↑↓</kbd> Navigate
          <kbd>↵</kbd> Select
          <kbd>Esc</kbd> Close
        </div>
      </div>
    </DialogContent>
  </DialogPortal>
</Dialog>
