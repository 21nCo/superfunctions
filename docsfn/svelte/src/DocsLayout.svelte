<script lang="ts">
  import type { Sidebar, DocHeading } from '@docsfn/core';
  import DocsSidebar from './DocsSidebar.svelte';
  import DocsToc from './DocsToc.svelte';
  
  export let sidebar: Sidebar | undefined = undefined;
  export let headings: DocHeading[] | undefined = undefined;
  export let activePath: string | undefined = undefined;
</script>

<div class="docsfn-layout">
  <header class="docsfn-topbar">
    <slot name="topbar" />
  </header>
  
  <div class="docsfn-container">
    {#if sidebar}
      <aside class="docsfn-sidebar-col">
        <DocsSidebar {sidebar} {activePath} />
      </aside>
    {/if}
    
    <main class="docsfn-main">
      <slot />
    </main>
    
    {#if headings && headings.length > 0}
      <aside class="docsfn-toc-col">
        <DocsToc {headings} />
      </aside>
    {/if}
  </div>
</div>
