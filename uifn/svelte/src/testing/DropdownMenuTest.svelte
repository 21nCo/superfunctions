<script lang="ts">
  import DropdownMenu from '../DropdownMenu.svelte';
  import DropdownMenuTrigger from '../DropdownMenuTrigger.svelte';
  import DropdownMenuContent from '../DropdownMenuContent.svelte';
  import DropdownMenuItem from '../DropdownMenuItem.svelte';
  import DropdownMenuLabel from '../DropdownMenuLabel.svelte';
  import DropdownMenuSeparator from '../DropdownMenuSeparator.svelte';

  let { defaultOpen = false } = $props();
</script>

<DropdownMenu {defaultOpen}>
  <DropdownMenuTrigger>Open Menu</DropdownMenuTrigger>
  <DropdownMenuContent>
    <DropdownMenuLabel>Actions</DropdownMenuLabel>
    <DropdownMenuSeparator />
    <DropdownMenuItem>Item 1</DropdownMenuItem>
    <DropdownMenuItem disabled>Item 2</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
