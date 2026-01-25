<script lang="ts">
  import type { Sidebar, SidebarItem } from '@docsfn/core';
  import {
    Collapsible,
    CollapsibleTrigger,
    CollapsibleContent,
    ScrollArea,
    ScrollAreaViewport,
  } from '@uifn/svelte';
  import SidebarGroup from './SidebarGroup.svelte';

  export let sidebar: Sidebar;
  export let activePath: string | undefined = undefined;
  export let defaultCollapsedGroups: string[] = [];
</script>

<ScrollArea class="docsfn-sidebar">
  <ScrollAreaViewport class="docsfn-sidebar-viewport">
    <nav class="docsfn-sidebar-nav">
      {#each sidebar.items as item, i (i)}
        <SidebarGroup 
          {item} 
          {activePath}
          defaultCollapsed={defaultCollapsedGroups.includes(item.text || '')}
        />
      {/each}
    </nav>
  </ScrollAreaViewport>
</ScrollArea>