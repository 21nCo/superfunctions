<script lang="ts">
  import ContextMenu from '../ContextMenu.svelte';
  import ContextMenuTrigger from '../ContextMenuTrigger.svelte';
  import ContextMenuContent from '../ContextMenuContent.svelte';
  import ContextMenuItem from '../ContextMenuItem.svelte';
</script>

<ContextMenu>
  <ContextMenuTrigger>
    <div style="width: 100px; height: 100px; background: grey;">Right click me</div>
  </ContextMenuTrigger>
  <ContextMenuContent>
    <ContextMenuItem>Item 1</ContextMenuItem>
    <ContextMenuItem>Item 2</ContextMenuItem>
  </ContextMenuContent>
</ContextMenu>
