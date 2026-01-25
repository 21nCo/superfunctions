<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  export interface PaginationPage {
    title: string;
    path: string;
  }

  export let prevPage: PaginationPage | undefined = undefined;
  export let nextPage: PaginationPage | undefined = undefined;
  export let sectionContext: string | undefined = undefined;

  let handleKeyDown: (e: KeyboardEvent) => void;

  onMount(() => {
    handleKeyDown = (e: KeyboardEvent) => {
      // Alt + Arrow Left = Previous page
      if (e.altKey && e.key === 'ArrowLeft' && prevPage) {
        window.location.href = prevPage.path;
      }
      // Alt + Arrow Right = Next page
      if (e.altKey && e.key === 'ArrowRight' && nextPage) {
        window.location.href = nextPage.path;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
  });

  onDestroy(() => {
    if (handleKeyDown) {
      window.removeEventListener('keydown', handleKeyDown);
    }
  });
</script>

{#if prevPage || nextPage}
  <nav class="docsfn-pagination" aria-label="Page navigation">
    {#if sectionContext}
      <div class="docsfn-pagination-context">
        {sectionContext}
      </div>
    {/if}
    
    <div class="docsfn-pagination-links">
      {#if prevPage}
        <a 
          href={prevPage.path} 
          class="docsfn-pagination-prev"
          rel="prev"
        >
          <svg 
            width="16" 
            height="16" 
            viewBox="0 0 16 16" 
            fill="none"
            aria-hidden="true"
          >
            <path 
              d="M10 12L6 8L10 4" 
              stroke="currentColor" 
              stroke-width="2" 
              stroke-linecap="round" 
              stroke-linejoin="round"
            />
          </svg>
          <div>
            <div class="docsfn-pagination-label">Previous</div>
            <div class="docsfn-pagination-title">{prevPage.title}</div>
          </div>
        </a>
      {:else}
        <div class="docsfn-pagination-spacer" />
      {/if}

      {#if nextPage}
        <a 
          href={nextPage.path} 
          class="docsfn-pagination-next"
          rel="next"
        >
          <div>
            <div class="docsfn-pagination-label">Next</div>
            <div class="docsfn-pagination-title">{nextPage.title}</div>
          </div>
          <svg 
            width="16" 
            height="16" 
            viewBox="0 0 16 16" 
            fill="none"
            aria-hidden="true"
          >
            <path 
              d="M6 4L10 8L6 12" 
              stroke="currentColor" 
              stroke-width="2" 
              stroke-linecap="round" 
              stroke-linejoin="round"
            />
          </svg>
        </a>
      {:else}
        <div class="docsfn-pagination-spacer" />
      {/if}
    </div>
  </nav>
{/if}
