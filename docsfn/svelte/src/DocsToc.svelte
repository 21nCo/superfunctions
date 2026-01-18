<script lang="ts">
  import type { DocHeading } from '@docsfn/core';
  
  export let headings: DocHeading[] = [];
  export let activeHash: string | undefined = undefined;
</script>

{#if headings.length > 0}
  <nav class="docsfn-toc">
    <div class="docsfn-toc-title">On this page</div>
    <ul>
      {#each headings as h (h.slug)}
        <li style="padding-left: {(h.level - 1) * 12}px">
          <a 
            href="#{h.slug}"
            class:active={activeHash === `#${h.slug}`}
          >
            {h.text}
          </a>
        </li>
      {/each}
    </ul>
  </nav>
{/if}
