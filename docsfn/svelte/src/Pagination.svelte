<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { DocsPageSurface } from "./DocsLayout.svelte";

  export interface PaginationPage {
    title: string;
    path: string;
  }

  export let surface: DocsPageSurface | undefined = undefined;
  export let prevPage: PaginationPage | undefined = undefined;
  export let nextPage: PaginationPage | undefined = undefined;
  export let sectionContext: string | undefined = undefined;

  let handleKeyDown: ((e: KeyboardEvent) => void) | undefined = undefined;

  $: resolvedPrevPage = prevPage ?? surface?.pagination?.prev;
  $: resolvedNextPage = nextPage ?? surface?.pagination?.next;

  onMount(() => {
    if (typeof window === "undefined") {
      return;
    }

    handleKeyDown = (e: KeyboardEvent) => {
      // Alt + Arrow Left = Previous page
      if (e.altKey && e.key === "ArrowLeft" && resolvedPrevPage) {
        window.location.href = resolvedPrevPage.path;
      }
      // Alt + Arrow Right = Next page
      if (e.altKey && e.key === "ArrowRight" && resolvedNextPage) {
        window.location.href = resolvedNextPage.path;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
  });

  onDestroy(() => {
    if (typeof window !== "undefined" && handleKeyDown) {
      window.removeEventListener("keydown", handleKeyDown);
    }
  });
</script>

{#if resolvedPrevPage || resolvedNextPage}
  <nav class="docsfn-pagination" aria-label="Page navigation">
    {#if sectionContext}
      <div class="docsfn-pagination-context">
        {sectionContext}
      </div>
    {/if}
    
    <div class="docsfn-pagination-links">
      {#if resolvedPrevPage}
        <a
          href={resolvedPrevPage.path}
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
            <div class="docsfn-pagination-title">{resolvedPrevPage.title}</div>
          </div>
        </a>
      {:else}
        <div class="docsfn-pagination-spacer" />
      {/if}

      {#if resolvedNextPage}
        <a
          href={resolvedNextPage.path}
          class="docsfn-pagination-next"
          rel="next"
        >
          <div>
            <div class="docsfn-pagination-label">Next</div>
            <div class="docsfn-pagination-title">{resolvedNextPage.title}</div>
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
