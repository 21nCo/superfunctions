<script lang="ts">
  import { onMount } from 'svelte';
  import { InMemorySearchFn } from 'searchfn';

  export let searchIndex: any; // Snapshot object
  export let placeholder = 'Search docs...';

  let isOpen = false;
  let query = '';
  let results: any[] = [];
  let engine: InMemorySearchFn | null = null;

  onMount(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        isOpen = true;
      }
      if (e.key === 'Escape') {
        isOpen = false;
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  $: if (searchIndex && !engine) {
    engine = new InMemorySearchFn({
      fields: ['title', 'description', 'headings', 'tags', 'body']
    });
    engine.importSnapshot(searchIndex);
  }

  $: if (engine && query) {
    results = engine.searchDetailed(query, { limit: 5, includeStored: true });
  } else {
    results = [];
  }

  function close() {
    isOpen = false;
  }
</script>

{#if !isOpen}
  <button 
    class="docsfn-search-trigger" 
    on:click={() => isOpen = true}
  >
    <span class="icon">🔍</span>
    <span class="placeholder">{placeholder}</span>
    <span class="shortcut">⌘K</span>
  </button>
{:else}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="docsfn-search-overlay" on:click={close}>
    <div class="docsfn-search-modal" on:click|stopPropagation>
      <header class="docsfn-search-header">
        <input
          autofocus
          type="text"
          class="docsfn-search-input"
          {placeholder}
          bind:value={query}
        />
      </header>
      <div class="docsfn-search-results">
        {#if results.length === 0 && query}
          <div class="docsfn-search-empty">No results found.</div>
        {/if}
        {#each results as hit (hit.docId)}
          <a 
            href={hit.document.path}
            class="docsfn-search-item"
            on:click={close}
          >
            <div class="docsfn-search-item-title">{hit.document.title}</div>
            {#if hit.document.description}
              <div class="docsfn-search-item-desc">{hit.document.description}</div>
            {/if}
          </a>
        {/each}
      </div>
    </div>
  </div>
{/if}
