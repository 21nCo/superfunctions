<script lang="ts">
  import MenuBar from '../MenuBar.svelte';
  import MenuBarMenu from '../MenuBarMenu.svelte';
  import MenuBarTrigger from '../MenuBarTrigger.svelte';
  import MenuBarContent from '../MenuBarContent.svelte';
  import DropdownMenuItem from '../DropdownMenuItem.svelte';

  let { value, defaultValue = '' } = $props();
</script>

<MenuBar {value} {defaultValue}>
  <MenuBarMenu value="file">
    <MenuBarTrigger>File</MenuBarTrigger>
    <MenuBarContent>
      <DropdownMenuItem>New File</DropdownMenuItem>
    </MenuBarContent>
  </MenuBarMenu>
  <MenuBarMenu value="edit">
    <MenuBarTrigger>Edit</MenuBarTrigger>
    <MenuBarContent>
      <DropdownMenuItem>Undo</DropdownMenuItem>
    </MenuBarContent>
  </MenuBarMenu>
</MenuBar>
