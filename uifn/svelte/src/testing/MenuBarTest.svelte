<script lang="ts">
  import MenuBar from '../MenuBar.svelte';
  import MenuBarMenu from '../MenuBarMenu.svelte';
  import MenuBarTrigger from '../MenuBarTrigger.svelte';
  import MenuBarContent from '../MenuBarContent.svelte';
  import DropdownMenuItem from '../DropdownMenuItem.svelte';

  let { value = '' } = $props();
</script>

<MenuBar {value}>
  <MenuBarMenu value="file">
    <MenuBarTrigger>File</MenuBarTrigger>
    <MenuBarContent>
      <DropdownMenuItem>New File</DropdownMenuItem>
    </MenuBarContent>
  </MenuBarMenu>
</MenuBar>
