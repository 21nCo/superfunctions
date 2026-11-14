<script lang="ts">
  import { Menu } from '@uifn/svelte/menu';

  const items = [{ id: 'rename' }, { id: 'duplicate' }, { id: 'delete' }];
</script>

<Menu.Root {items}>
  <Menu.Trigger>Actions</Menu.Trigger>
  <Menu.Positioner>
    <Menu.Content>
      <Menu.Item value="rename">Rename</Menu.Item>
      <Menu.Item value="duplicate">Duplicate</Menu.Item>
      <Menu.Item value="delete">Delete</Menu.Item>
    </Menu.Content>
  </Menu.Positioner>
</Menu.Root>
