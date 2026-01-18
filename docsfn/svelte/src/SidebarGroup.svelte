<script lang="ts">
  import type { SidebarItem } from '@docsfn/core';
  
  export let item: SidebarItem;
  export let activePath: string | undefined = undefined;
</script>

{#if item.type === 'separator'}
  <hr class="docsfn-sidebar-separator" />
{:else if item.type === 'group'}
  <div class="docsfn-sidebar-group">
    <div class="docsfn-sidebar-group-title">{item.text}</div>
    <div class="docsfn-sidebar-group-items">
      {#if item.items}
        {#each item.items as sub}
          <svelte:self item={sub} {activePath} />
        {/each}
      {/if}
    </div>
  </div>
{:else}
  <a 
    href={item.link} 
    class="docsfn-sidebar-link" 
    class:active={activePath === item.link}
  >
    {item.text}
  </a>
{/if}
