<script lang="ts">
  import type { SidebarItem } from '@docsfn/core';
  import {
    Collapsible,
    CollapsibleTrigger,
    CollapsibleContent,
  } from '@uifn/svelte';

  export let item: SidebarItem;
  export let activePath: string | undefined = undefined;
  export let defaultCollapsed = false;
  export let depth = 0;

  function hasActiveLink(item: SidebarItem, activePath?: string): boolean {
    if (item.type === 'link' && item.link === activePath) {
      return true;
    }
    if (item.type === 'group' && item.items) {
      return item.items.some(child => hasActiveLink(child, activePath));
    }
    return false;
  }

  $: hasActiveChild = hasActiveLink(item, activePath);
  $: isActive = item.type === 'link' && activePath === item.link;
</script>

{#if item.type === 'separator'}
  <hr class="docsfn-sidebar-separator" />
{:else if item.type === 'group'}
  <Collapsible 
    class="docsfn-sidebar-group" 
    data-depth={depth}
    defaultOpen={defaultCollapsed ? false : (item.collapsed === false || hasActiveChild)}
  >
    <CollapsibleTrigger class="docsfn-sidebar-group-trigger">
      <span class="docsfn-sidebar-group-icon">
        <svg 
          width="12" 
          height="12" 
          viewBox="0 0 12 12" 
          fill="none" 
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path 
            d="M4 3L7 6L4 9" 
            stroke="currentColor" 
            stroke-width="1.5" 
            stroke-linecap="round" 
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <span class="docsfn-sidebar-group-text">{item.text}</span>
    </CollapsibleTrigger>
    
    <CollapsibleContent class="docsfn-sidebar-group-content">
      {#if item.items}
        {#each item.items as sub, i (i)}
          <svelte:self 
            item={sub} 
            {activePath}
            depth={depth + 1}
          />
        {/each}
      {/if}
    </CollapsibleContent>
  </Collapsible>
{:else if item.type === 'link'}
  <a 
    href={item.link} 
    class="docsfn-sidebar-link {isActive ? 'active' : ''}"
    data-active={isActive}
    data-depth={depth}
    aria-current={isActive ? 'page' : undefined}
  >
    {item.text}
  </a>
{/if}
