<script lang="ts">
  import type { Sidebar } from '@docsfn/core';
  import SidebarGroup from './SidebarGroup.svelte';
  
  export let sidebar: Sidebar;
  export let activePath: string | undefined = undefined;
</script>

<nav class="docsfn-sidebar">
  {#each sidebar.items as item}
    <SidebarGroup {item} {activePath} />
  {/each}
</nav>