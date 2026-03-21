<script lang="ts">
  import type { Sidebar } from "@docsfn/core";
  import { ScrollArea, ScrollAreaViewport } from "@uifn/svelte";
  import SidebarGroup from "./SidebarGroup.svelte";
  import type { DocsPageSurface } from "./DocsLayout.svelte";

  export let surface: DocsPageSurface | undefined = undefined;
  export let sidebar: Sidebar | undefined = undefined;
  export let activePath: string | undefined = undefined;
  export let defaultCollapsedGroups: string[] = [];

  $: resolvedSidebar = sidebar ?? surface?.sidebar;
  $: resolvedActivePath = activePath ?? surface?.route;
</script>

{#if resolvedSidebar}
  <ScrollArea class="docsfn-sidebar">
    <ScrollAreaViewport class="docsfn-sidebar-viewport">
      <nav class="docsfn-sidebar-nav">
        {#each resolvedSidebar.items as item, i (`${item.type}:${i}`)}
          <SidebarGroup
            {item}
            activePath={resolvedActivePath}
            defaultCollapsed={defaultCollapsedGroups.includes(item.text || "")}
          />
        {/each}
      </nav>
    </ScrollAreaViewport>
  </ScrollArea>
{/if}
