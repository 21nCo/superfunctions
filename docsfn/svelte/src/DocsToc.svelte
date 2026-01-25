<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { DocHeading } from '@docsfn/core';
  import { ScrollArea, ScrollAreaViewport } from '@uifn/svelte';

  export let headings: DocHeading[];
  export let activeHash: string | undefined = undefined;

  let currentHash = activeHash || '';
  let observer: IntersectionObserver;

  // Auto-detect active heading based on scroll position
  onMount(() => {
    if (activeHash !== undefined) {
      currentHash = activeHash;
      return;
    }

    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('id');
            if (id) {
              currentHash = `#${id}`;
            }
          }
        });
      },
      {
        rootMargin: '-80px 0px -80% 0px',
        threshold: 1.0,
      }
    );

    // Observe all heading elements
    headings.forEach((h) => {
      const element = document.getElementById(h.slug);
      if (element) {
        observer.observe(element);
      }
    });
  });

  onDestroy(() => {
    if (observer) {
      observer.disconnect();
    }
  });

  function handleClick(e: MouseEvent, slug: string) {
    e.preventDefault();
    const element = document.getElementById(slug);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      currentHash = `#${slug}`;
      // Update URL without triggering navigation
      window.history.replaceState(null, '', `#${slug}`);
    }
  }
</script>

{#if headings.length > 0}
  <ScrollArea class="docsfn-toc">
    <ScrollAreaViewport class="docsfn-toc-viewport">
      <nav class="docsfn-toc-nav" aria-label="Table of contents">
        <div class="docsfn-toc-title">On this page</div>
        <ul class="docsfn-toc-list">
          {#each headings as h (h.slug)}
            {@const isActive = currentHash === `#${h.slug}`}
            <li 
              class="docsfn-toc-item"
              data-level={h.level}
              style="padding-left: {(h.level - 1) * 12}px"
            >
              <a 
                href="#{h.slug}"
                on:click={(e) => handleClick(e, h.slug)}
                class="docsfn-toc-link {isActive ? 'active' : ''}"
                data-active={isActive}
                aria-current={isActive ? 'location' : undefined}
              >
                {h.text}
              </a>
            </li>
          {/each}
        </ul>
      </nav>
    </ScrollAreaViewport>
  </ScrollArea>
{/if}
